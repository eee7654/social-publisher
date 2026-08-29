import 'server-only'; // این فایل فقط در سرور اجرا می‌شود

const dictionaries = {
  fa: () => import('@/dictionaries/fa.json').then((module) => module.default),
  en: () => import('@/dictionaries/en.json').then((module) => module.default),
};

export const getDictionary = async (locale) => dictionaries[locale]?.() ?? dictionaries.fa();