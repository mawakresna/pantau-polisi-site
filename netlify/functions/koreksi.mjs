// Menerima koreksi editor dari halaman kasus, dan menyajikannya kembali.
//
// Kenapa koreksi tidak disimpan di repo situs: `publish-site.sh` menimpa repo
// itu dengan satu commit tunggal setiap malam, jadi apa pun yang ditulis ke
// sana akan hilang esok paginya. Koreksi disimpan di repo terpisah, dan
// riwayat git repo itu sekaligus menjadi catatan siapa mengubah apa dan kapan
// — tanpa perlu tabel audit tersendiri.
//
// Sesudah tersimpan, pipeline lokal menariknya sebelum normalisasi dan
// menerapkannya sebagai sumber prioritas tertinggi, di atas LLM dan regex.
// Dengan begitu koreksi bertahan melewati pembangunan ulang, bukan cuma
// menempel di tampilan.
//
// Wajib ada di environment Netlify:
//   GITHUB_TOKEN   — token dengan izin tulis HANYA ke repo koreksi
//   KOREKSI_REPO   — "akun/nama-repo"
// Keduanya diisi lewat antarmuka Netlify, tidak pernah masuk ke repo mana pun.

const BERKAS = "koreksi.json";
const BERKAS_KATEGORI = "kategori.json";
const BERKAS_KEMBAR = "kembar-keputusan.json";
const CABANG = "main";

// Jenis pelanggaran yang diketik editor sendiri. Daftar bawaan tidak akan
// pernah lengkap — "desersi" tidak ada di sana sampai satu kasus menuntutnya —
// tapi ketikan bebas per kasus akan memecah hitungan grafik tanpa terlihat.
// Jalan tengahnya: yang diketik disimpan sebagai kategori tetap di sini, lalu
// scripts/kosakata.py menggabungkannya ke kosakata baku sambil membuang yang
// kembar. Jadi editor bebas menambah, tapi tidak bebas menambah dua kali.
const BATAS_LABEL = 60;

function kodekan(label) {
  return label.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

function rapikan(label) {
  const t = String(label ?? "").replace(/\s+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

// Hanya field ini yang boleh diubah. Daftar tertutup: tanpa ini, satu POST
// yang dibuat-buat bisa menulis kunci sembarang ke dalam berkas koreksi.
const FIELD_SAH = new Set([
  "judul", "ringkasan", "pelanggaran", "tanggal_kejadian",
  "provinsi", "status", "vonis", "sanksi",
]);

const KODE_KASUS = /^PP-\d{6}$/;
const BATAS_PANJANG = { ringkasan: 4000, judul: 300 };

function jawab(status, data, tambahan = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...tambahan,
    },
  });
}

async function periksaPengguna(request, context) {
  const auth = request.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+/i.test(auth)) return null;
  const situs = (context.site && context.site.url) || "";
  if (!situs) return null;
  try {
    const r = await fetch(`${situs}/.netlify/identity/user`,
                          { headers: { Authorization: auth } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}


async function github(jalur, opsi = {}) {
  const repo = process.env.KOREKSI_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("KOREKSI_REPO atau GITHUB_TOKEN belum diisi");
  const respons = await fetch(`https://api.github.com/repos/${repo}/${jalur}`, {
    ...opsi,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pantau-polisi",
      ...(opsi.headers || {}),
    },
  });
  return respons;
}

async function bacaBerkas(nama, bawaan) {
  const respons = await github(`contents/${nama}?ref=${CABANG}`);
  if (respons.status === 404) return { isi: bawaan, sha: null };
  if (!respons.ok) throw new Error(`GitHub ${respons.status}`);
  const data = await respons.json();
  const teks = Buffer.from(data.content, "base64").toString("utf-8");
  return { isi: JSON.parse(teks || JSON.stringify(bawaan)), sha: data.sha };
}

async function tulisBerkas(nama, isi, sha, pesan) {
  return github(`contents/${nama}`, {
    method: "PUT",
    body: JSON.stringify({
      message: pesan,
      branch: CABANG,
      content: Buffer.from(JSON.stringify(isi, null, 2), "utf-8").toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });
}

async function ambilKoreksi() {
  return bacaBerkas(BERKAS, {});
}

async function simpanKoreksi(isi, sha, pesan) {
  return tulisBerkas(BERKAS, isi, sha, pesan);
}

// Menambah satu jenis pelanggaran baru. Dipisah dari jalur koreksi biasa
// karena yang ditulis bukan nilai satu kasus, melainkan kosakata yang dipakai
// seluruh kasus sesudahnya.
async function tambahKategori(label, nama) {
  const rapi = rapikan(label);
  if (!rapi) return jawab(400, { galat: "jenis pelanggaran tidak boleh kosong" });
  if (rapi.length > BATAS_LABEL) {
    return jawab(400, { galat: `paling panjang ${BATAS_LABEL} huruf` });
  }
  const kode = kodekan(rapi);
  if (!kode) return jawab(400, { galat: "jenis pelanggaran harus memuat huruf atau angka" });

  for (let percobaan = 0; percobaan < 3; percobaan += 1) {
    const { isi, sha } = await bacaBerkas(BERKAS_KATEGORI, {});
    // Kembar diperiksa tanpa memandang besar-kecil huruf: "Desersi" dan
    // "desersi" harus jadi satu kategori, bukan dua kolom terpisah di grafik.
    const adaKode = Object.prototype.hasOwnProperty.call(isi, kode);
    const adaLabel = Object.values(isi).some(
      (v) => String(v.label || "").toLowerCase() === rapi.toLowerCase());
    if (adaKode || adaLabel) {
      const lama = isi[kode] ? isi[kode].label : rapi;
      return jawab(200, { kode, label: lama, sudah_ada: true });
    }
    isi[kode] = { label: rapi, oleh: nama, pada: new Date().toISOString() };
    const respons = await tulisBerkas(
      BERKAS_KATEGORI, isi, sha, `Jenis pelanggaran baru: ${rapi} — ${nama}`);
    if (respons.ok) return jawab(200, { kode, label: rapi, sudah_ada: false });
    if (respons.status !== 409 && respons.status !== 422) {
      return jawab(502, { galat: `GitHub ${respons.status}` });
    }
  }
  return jawab(409, { galat: "ada editor lain menyimpan bersamaan, coba lagi" });
}

// Keputusan editor atas usulan kasus kembar. Dipisah dari koreksi biasa karena
// yang dicatat bukan nilai satu kasus, melainkan hubungan antara dua kasus —
// dan karena penolakan harus ikut tercatat. Tanpa merekam "beda perkara",
// sapuan malam menyodorkan pasangan yang sama berulang-ulang sampai orang
// berhenti membacanya.
async function catatKembar(a, b, keputusan, alasan, nama) {
  if (!KODE_KASUS.test(String(a || "")) || !KODE_KASUS.test(String(b || ""))) {
    return jawab(400, { galat: "kode kasus tidak sah" });
  }
  if (a === b) return jawab(400, { galat: "dua kasus yang sama" });
  if (keputusan !== "kembar" && keputusan !== "beda") {
    return jawab(400, { galat: "keputusan harus 'kembar' atau 'beda'" });
  }
  const [x, y] = [a, b].sort();
  const sekarang = new Date().toISOString();

  for (let percobaan = 0; percobaan < 3; percobaan += 1) {
    const { isi, sha } = await bacaBerkas(BERKAS_KEMBAR, { keputusan: [] });
    const daftar = Array.isArray(isi.keputusan) ? isi.keputusan : [];
    // Keputusan terakhir menang: editor boleh berubah pikiran, dan yang salah
    // adalah menyimpan dua baris yang saling bertentangan untuk satu pasangan.
    const bersih = daftar.filter((k) => !(k.a === x && k.b === y));
    bersih.push({ a: x, b: y, keputusan,
                  alasan: String(alasan || "").slice(0, 500),
                  oleh: nama, dicatat: sekarang });
    const respons = await tulisBerkas(
      BERKAS_KEMBAR, { keputusan: bersih }, sha,
      `${x} ~ ${y}: ${keputusan} — ${nama}`);
    if (respons.ok) return jawab(200, { a: x, b: y, keputusan, oleh: nama, pada: sekarang });
    if (respons.status !== 409 && respons.status !== 422) {
      return jawab(502, { galat: `GitHub ${respons.status}` });
    }
  }
  return jawab(409, { galat: "ada editor lain menyimpan bersamaan, coba lagi" });
}

export default async (request, context) => {
  if (request.method === "GET") {
    const kasus = new URL(request.url).searchParams.get("kasus");
    if (!kasus || !KODE_KASUS.test(kasus)) return jawab(400, { galat: "kode kasus tidak sah" });
    try {
      const { isi } = await ambilKoreksi();
      // Ditembolokkan sebentar: halaman kasus memanggilnya tiap kali dibuka,
      // sementara koreksi jarang berubah. Satu menit sudah memangkas
      // sebagian besar panggilan tanpa membuat editan terasa tertunda.
      return jawab(200, { kasus, koreksi: isi[kasus] || {} },
                   { "Cache-Control": "public, max-age=60" });
    } catch (galat) {
      return jawab(502, { galat: String(galat.message || galat) });
    }
  }

  if (request.method !== "POST") return jawab(405, { galat: "metode tidak didukung" });

  // Token diperiksa ke Netlify Identity sendiri. Versi sebelumnya membaca
  // `context.clientContext.user`, yang TIDAK PERNAH terisi pada format fungsi
  // versi 2 — jadi setiap penyimpanan ditolak, termasuk dari editor yang sudah
  // benar-benar masuk. Pemeriksaan tetap di sisi server: tombol yang
  // disembunyikan di halaman bukan pengaman.
  const pengguna = await periksaPengguna(request, context);
  if (!pengguna) return jawab(401, { galat: "harus masuk sebagai editor" });

  let muatan;
  try {
    muatan = await request.json();
  } catch {
    return jawab(400, { galat: "isi permintaan bukan JSON" });
  }

  const nama0 = pengguna.user_metadata?.full_name || pengguna.email || "editor";
  if (muatan && muatan.aksi === "tambah-kategori") {
    try {
      return await tambahKategori(muatan.label, nama0);
    } catch (galat) {
      return jawab(502, { galat: String(galat.message || galat) });
    }
  }

  if (muatan && muatan.aksi === "kembar") {
    try {
      return await catatKembar(muatan.a, muatan.b, muatan.keputusan,
                               muatan.alasan, nama0);
    } catch (galat) {
      return jawab(502, { galat: String(galat.message || galat) });
    }
  }

  const { kasus, field, nilai, alasan } = muatan || {};
  if (!KODE_KASUS.test(String(kasus || ""))) return jawab(400, { galat: "kode kasus tidak sah" });
  if (!FIELD_SAH.has(field)) return jawab(400, { galat: `field '${field}' tidak boleh diubah` });
  const teks = String(nilai ?? "").trim();
  if (teks.length > (BATAS_PANJANG[field] || 200)) {
    return jawab(400, { galat: "nilai terlalu panjang" });
  }

  const nama = pengguna.user_metadata?.full_name || pengguna.email || "editor";
  const sekarang = new Date().toISOString();

  // Tabrakan dua editor ditangani dengan mencoba ulang: GitHub menolak PUT
  // bila sha-nya sudah usang, dan yang benar adalah membaca ulang lalu
  // menumpuk perubahan — bukan memaksa timpa dan menghapus kerja orang lain.
  for (let percobaan = 0; percobaan < 3; percobaan += 1) {
    try {
      const { isi, sha } = await ambilKoreksi();
      isi[kasus] = isi[kasus] || {};
      if (teks === "") {
        delete isi[kasus][field];
        if (Object.keys(isi[kasus]).length === 0) delete isi[kasus];
      } else {
        isi[kasus][field] = {
          nilai: teks,
          alasan: String(alasan || "").slice(0, 500),
          oleh: nama,
          pada: sekarang,
        };
      }
      const respons = await simpanKoreksi(
        isi, sha, `${kasus} ${field} — ${nama}`);
      if (respons.ok) {
        return jawab(200, { kasus, field, nilai: teks, oleh: nama, pada: sekarang });
      }
      if (respons.status !== 409 && respons.status !== 422) {
        return jawab(502, { galat: `GitHub ${respons.status}` });
      }
    } catch (galat) {
      return jawab(502, { galat: String(galat.message || galat) });
    }
  }
  return jawab(409, { galat: "ada editor lain menyimpan bersamaan, coba lagi" });
};
