import { timingSafeEqual } from "node:crypto";

function env(nama) {
  try {
    if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(nama) || "";
  } catch {
    // Pengujian lokal tidak menyediakan objek Netlify.
  }
  return process.env[nama] || "";
}

function sama(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function akunBersama(request) {
  const auth = request.headers.get("authorization") || "";
  if (!/^Basic\s+\S+$/i.test(auth)) return null;

  let isi;
  try {
    isi = Buffer.from(auth.replace(/^Basic\s+/i, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
  const batas = isi.indexOf(":");
  if (batas < 1) return null;

  const pengguna = isi.slice(0, batas);
  const sandi = isi.slice(batas + 1);
  const penggunaBenar = env("EDITOR_USERNAME");
  const sandiBenar = env("EDITOR_PASSWORD");
  if (!penggunaBenar || !sandiBenar ||
      !sama(pengguna, penggunaBenar) || !sama(sandi, sandiBenar)) return null;

  return {
    id: "editor-bersama",
    email: penggunaBenar,
    user_metadata: { full_name: "Editor bersama" },
  };
}

// Akun bersama adalah jalur utama. Netlify Identity dipertahankan sementara
// agar editor undangan lama dan tombol sunting pada halaman kasus tidak putus
// ketika perubahan ini mulai dipakai.
export async function periksaEditor(request, context = {}) {
  const bersama = akunBersama(request);
  if (bersama) return bersama;

  const auth = request.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+/i.test(auth)) return null;
  const situs = context.site?.url || "";
  if (!situs) return null;
  try {
    const respons = await fetch(`${situs}/.netlify/identity/user`, {
      headers: { Authorization: auth },
    });
    return respons.ok ? await respons.json() : null;
  } catch {
    return null;
  }
}
