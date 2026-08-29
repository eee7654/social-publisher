import { atom } from 'jotai';
import { createMongoAbility } from '@casl/ability';

export const rulesAtom = atom([]);

export const abilityAtom = atom(createMongoAbility([]));

export const userAtom = atom(null);