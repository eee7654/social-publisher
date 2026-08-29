// src/components/providers/app-hydrator.jsx
"use client";

import { useHydrateAtoms } from 'jotai/utils';
import { rulesAtom, abilityAtom, userAtom } from '@/store/authAtom';
import { dictAtom, langAtom, dirAtom } from '@/store/i18nAtom';
import { createMongoAbility } from '@casl/ability';

export function AppHydrator({ rules, user, dict, lang, dir, children }) {
  // 🚀 تزریق همزمانِ تمام دیتای حیاتیِ سرور به استیتِ گلوبال
  useHydrateAtoms([
    [rulesAtom, rules || []],
    [abilityAtom, createMongoAbility(rules || [])],
    [userAtom, user || null],
    [dictAtom, dict || {}],
    [langAtom, lang || 'fa'],
    [dirAtom, dir || 'rtl'],
  ]);

  return <>{children}</>;
}