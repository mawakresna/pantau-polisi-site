// Bahan kerja editor: antrean kasus dan teks berita penuh.
//
// Teks berita sengaja TIDAK ikut tercetak di halaman. Halaman statis tidak bisa
// menyembunyikan isinya — form login hanya menyembunyikan tampilan, tidak
// datanya. Karena itu bahan hanya dikirim dari sini, sesudah kredensial editor
// diperiksa di sisi server. Tanpa kredensial yang sah, tidak ada satu pun
// baris teks yang keluar.
//
// Sumbernya repo koreksi yang privat, diisi oleh scripts/ekspor-bahan-editor.py.

import { periksaEditor } from "./_shared/editor-auth.mjs";

const CABANG = "main";
const KODE_KASUS = /^PP-\d{6}$/;
const FIELD_SAH = new Set([
  "judul", "ringkasan", "pelanggaran", "tanggal_kejadian",
  "provinsi", "status", "vonis", "sanksi",
]);

function jawab(status, data, tambahan = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Bahan editor tidak boleh singgah di tembolok bersama mana pun.
      "Cache-Control": "private, no-store",
      ...tambahan,
    },
  });
}

async function github(jalur) {
  const repo = process.env.KOREKSI_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("KOREKSI_REPO atau GITHUB_TOKEN belum diisi");
  return fetch(`https://api.github.com/repos/${repo}/${jalur}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.raw",
      "User-Agent": "pantau-polisi",
    },
  });
}

export const pengguna = periksaEditor;

// bahan/PP-xxxxxx.json adalah potret hasil pipeline terakhir, sedangkan
// koreksi.json berubah setiap kali editor menekan Simpan. Kartu yang dibuka
// ulang harus selalu memakai koreksi sebagai lapisan paling atas; kalau tidak,
// penyimpanan berhasil tetapi formulir memamerkan nilai lama lagi.
export function tempelKoreksiKeBahan(bahan, koreksi) {
  bahan.nilai = bahan.nilai || {};
  const tercatat = {};
  for (const [field, perubahan] of Object.entries(koreksi || {})) {
    if (!FIELD_SAH.has(field) || !perubahan ||
        !Object.prototype.hasOwnProperty.call(perubahan, "nilai")) continue;
    const nilai = String(perubahan.nilai ?? "");
    bahan.nilai[field] = nilai;
    if (field === "judul") bahan.judul = nilai || "Tanpa judul";
    tercatat[field] = {
      oleh: perubahan.oleh || "",
      pada: perubahan.pada || "",
    };
  }
  if (Object.keys(tercatat).length) bahan.dikoreksi = tercatat;
  return bahan;
}

export default async (request, context) => {
  // Diperiksa lebih dulu, sebelum apa pun dibaca.
  const editor = await periksaEditor(request, context);
  if (!editor) return jawab(401, { galat: "harus masuk sebagai editor" });

  const url = new URL(request.url);
  const kasus = url.searchParams.get("kasus");

  try {
    if (!kasus) {
      const respons = await github(`contents/antrean.json?ref=${CABANG}`);
      if (respons.status === 404) {
        return jawab(200, { jumlah: 0, kasus: [],
                            catatan: "Antrean belum pernah disiapkan." });
      }
      if (!respons.ok) return jawab(502, { galat: `GitHub ${respons.status}` });
      const antrean = JSON.parse(await respons.text());
      // Jenis pelanggaran tambahan ikut dikirim bersama antrean. Daftar pilihan
      // di halaman dicetak saat situs dibangun, jadi kategori yang ditambahkan
      // editor hari ini baru masuk ke sana besok malam — tanpa baris ini,
      // kategori yang baru saja dibuat hilang lagi begitu halaman dimuat ulang.
      try {
        const kat = await github(`contents/kategori.json?ref=${CABANG}`);
        antrean.kategori = kat.ok ? JSON.parse(await kat.text()) : {};
      } catch {
        antrean.kategori = {};
      }

      // Kasus yang jenis pelanggarannya sudah diputuskan editor.
      //
      // antrean.json cuma potret: dibuat ulang saat pipeline jalan, jadi
      // sepanjang hari ia tidak tahu apa-apa soal koreksi yang baru masuk.
      // Tanpa daftar ini, editor bekerja seharian dan angkanya tidak bergerak
      // sedikit pun — daftar kerja yang tidak pernah berkurang.
      try {
        const kor = await github(`contents/koreksi.json?ref=${CABANG}`);
        const isi = kor.ok ? JSON.parse(await kor.text()) : {};
        antrean.diputus = Object.keys(isi).filter(
          (kasus) => isi[kasus] && isi[kasus].pelanggaran);
        // Judul yang sudah dibetulkan editor hari ini, dari berkas yang sama.
        // antrean.json baru ditulis ulang malam nanti, jadi tanpa peta ini
        // editor membetulkan nama lalu melihat baris kasusnya tetap memakai
        // judul lama sampai besok — seolah suntingannya tidak tersimpan.
        antrean.judul = {};
        for (const kasus of Object.keys(isi)) {
          const j = isi[kasus] && isi[kasus].judul;
          if (j && j.nilai) antrean.judul[kasus] = j.nilai;
        }
      } catch {
        antrean.diputus = [];
        antrean.judul = {};
      }

      // Usulan kasus kembar dari sapuan keutuhan, beserta pasangan yang sudah
      // diputuskan. Keduanya dikirim bersama antrean supaya halaman tidak
      // menampilkan lagi pasangan yang baru saja dijawab editor pagi ini —
      // kembar.json baru ditulis ulang malam nanti.
      try {
        const km = await github(`contents/kembar.json?ref=${CABANG}`);
        antrean.kembar = km.ok ? JSON.parse(await km.text()).pasangan || [] : [];
      } catch {
        antrean.kembar = [];
      }
      try {
        const kp = await github(`contents/kembar-keputusan.json?ref=${CABANG}`);
        const isi = kp.ok ? JSON.parse(await kp.text()) : {};
        antrean.kembar_diputus = (isi.keputusan || []).map((k) => `${k.a}~${k.b}`);
      } catch {
        antrean.kembar_diputus = [];
      }
      // Keputusan mengeluarkan kasus juga harus berlaku seketika di ruang
      // editor. Tanpa daftar ini, kasus yang baru dihapus muncul lagi setelah
      // memuat ulang halaman sampai pipeline berikutnya selesai.
      try {
        const dk = await github(`contents/dikeluarkan-keputusan.json?ref=${CABANG}`);
        const isi = dk.ok ? JSON.parse(await dk.text()) : {};
        antrean.dikeluarkan = (isi.keputusan || []).map((k) => k.kasus);
      } catch {
        antrean.dikeluarkan = [];
      }
      return jawab(200, antrean);
    }

    if (!KODE_KASUS.test(kasus)) return jawab(400, { galat: "kode kasus tidak sah" });
    const [respons, responsKoreksi] = await Promise.all([
      github(`contents/bahan/${kasus}.json?ref=${CABANG}`),
      github(`contents/koreksi.json?ref=${CABANG}`),
    ]);
    if (respons.status === 404) {
      return jawab(404, {
        galat: "bahan kasus ini belum disiapkan",
        petunjuk: "Kasus di luar antrean belum punya salinan teks beritanya.",
      });
    }
    if (!respons.ok) return jawab(502, { galat: `GitHub ${respons.status}` });
    if (!responsKoreksi.ok && responsKoreksi.status !== 404) {
      return jawab(502, { galat: `GitHub koreksi ${responsKoreksi.status}` });
    }
    const bahan = JSON.parse(await respons.text());
    const semuaKoreksi = responsKoreksi.ok
      ? JSON.parse(await responsKoreksi.text()) : {};
    return jawab(200, tempelKoreksiKeBahan(bahan, semuaKoreksi[kasus] || {}));
  } catch (galat) {
    return jawab(502, { galat: String(galat.message || galat) });
  }
};

