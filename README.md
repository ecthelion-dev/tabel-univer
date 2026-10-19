# Tabel tizimi: Netlify uchun paket

Bo'limlar tabelni o'zi to'ldiradi, kadrlar bo'limi tasdiqlaydi, tabel chop etiladi va imzolanadi.

## Fayllar
- `public/index.html`: butun ilova (bitta fayl)
- `netlify/functions/api.mjs`: server qismi (login, huquqlar, saqlash)
- `netlify/functions/seed.mjs`: namuna ma'lumotlar (birinchi ishga tushishda bir marta yuklanadi)
- `netlify.toml`, `package.json`: sozlamalar

## Joylash (muhim)
Funksiya va `@netlify/blobs` kutubxonasi bo'lgani uchun oddiy "papkani sudrab tashlash" yetmasligi mumkin. Ishonchli yo'llar:

**A) GitHub orqali (tavsiya)**
1. Papkani GitHub repozitoriyga yuklang.
2. Netlify: Add new site, Import from Git, shu repozitoriyni tanlang. Boshqa sozlama kerak emas.

**B) Netlify CLI orqali**
```
npm i -g netlify-cli
npm install
netlify deploy --prod
```

## Muhit o'zgaruvchilari (Site settings, Environment variables)
| Nomi | Nima uchun |
|---|---|
| `ADMIN_PASS` | Admin paroli (majburiy) |
| `KADR_PASS` | Kadrlar bo'limi paroli |
| `BUXG_PASS` | Buxgalter paroli |
| `SECRET` | Sessiya kaliti, uzun tasodifiy matn (tavsiya) |
| `NO_SEED` | `1` qo'ysangiz namuna ma'lumotlar yuklanmaydi (birinchi deployda qo'ying) |

O'zgaruvchilarni kiritgach saytni qayta deploy qiling.

## Birinchi ishga tushirish
1. Saytni oching, Admin sifatida kiring.
2. Sozlamalar: muassasa nomi, rektor, prorektor, tabel tuzuvchi, bayram kunlarini kiriting.
3. Bo'limlar va xodimlarni qo'shing (ro'yxatdan qo'yish mumkin).
4. Sozlamalarda "Parollarni yaratish" tugmasini bosing va har bo'lim mudiriga o'z parolini bering.

## Huquqlar (serverda tekshiriladi)
- **Bo'lim mudiri:** faqat o'z bo'limi. Istisno kiritadi, tabelni tasdiqqa yuboradi. Yuborilgach kadrlar qaytarmaguncha o'zgartira olmaydi.
- **Kadrlar bo'limi:** xodimlar, istisnolar, tasdiqlash va qaytarish.
- **Buxgalter:** faqat ko'radi va yuklab oladi.
- **Admin:** hamma narsa, shu jumladan bo'limlar, sozlamalar va parollar.

## Chop etish
"Chop etish uchun yuklab olish" yangi oynada A4 gorizontal tabelni ochadi va chop etish oynasini chiqaradi.

## Cheklovlar
- Ma'lumot Netlify Blobs'da JSON ko'rinishida saqlanadi. Yuzlab xodim va bir necha o'n bo'lim uchun yetarli. Juda katta hajm yoki bir vaqtda ko'p yozuv bo'lsa, MySQL/Postgres'ga o'tish kerak.
- Ikki kishi bir lahzada bir xil turdagi yozuvni saqlasa, oxirgisi yutadi (kamdan-kam holat).
- Login urinishlari soni cheklanmagan. Parollarni uzun qo'ying.
- Sahifa har 60 soniyada va oynaga qaytilganda yangilanadi; o'z o'zgarishlaringiz darhol ko'rinadi. Bu Netlify bepul limitini tejaydi.
