/**
 * The place names donor viewers may see (docs/SECURITY_SETUP.md §8.3): the two regions and the 16
 * governorates of the State of Palestine (ADM1 and ADM2, as used by PCBS and OCHA oPt), in English and
 * Modern Standard Arabic, with common spellings. Anything else typed into an area or governorate field (a
 * village, a camp, a street, coordinates, a plus code, a name) is not shown to donors. One list for the
 * whole API: add a place here, never in a route.
 */

export interface Place {
  en: string;
  ar: string;
  /** Other spellings, in either script; matched after normalisation (see normalisePlace). */
  aliases: readonly string[];
}

export const DONOR_PLACES: readonly Place[] = [
  { en: 'West Bank', ar: 'الضفة الغربية', aliases: [] },
  { en: 'Gaza Strip', ar: 'قطاع غزة', aliases: [] },
  { en: 'Jenin', ar: 'جنين', aliases: [] },
  { en: 'Tubas', ar: 'طوباس', aliases: ['Tubas and Northern Jordan Valley', 'طوباس والأغوار الشمالية'] },
  { en: 'Tulkarm', ar: 'طولكرم', aliases: ['Tulkarem', 'Tul Karm'] },
  { en: 'Nablus', ar: 'نابلس', aliases: [] },
  { en: 'Qalqilya', ar: 'قلقيلية', aliases: ['Qalqiliya', 'Qalqilia', 'Qalqiliyah'] },
  { en: 'Salfit', ar: 'سلفيت', aliases: [] },
  { en: 'Ramallah and Al-Bireh', ar: 'رام الله والبيرة', aliases: ['Ramallah', 'Ramallah & Al-Bireh', 'Ramallah and Al Bireh', 'Ramallah & Al Bireh', 'رام الله'] },
  { en: 'Jericho and Al-Aghwar', ar: 'أريحا والأغوار', aliases: ['Jericho', 'Jericho & Al-Aghwar', 'Jericho and Al Aghwar', 'أريحا'] },
  { en: 'Jerusalem', ar: 'القدس', aliases: ['East Jerusalem', 'Al-Quds', 'Al Quds', 'القدس الشرقية'] },
  { en: 'Bethlehem', ar: 'بيت لحم', aliases: [] },
  { en: 'Hebron', ar: 'الخليل', aliases: ['Al-Khalil', 'Al Khalil'] },
  { en: 'North Gaza', ar: 'شمال غزة', aliases: ['Gaza North'] },
  { en: 'Gaza', ar: 'غزة', aliases: ['Gaza City', 'مدينة غزة'] },
  { en: 'Deir al-Balah', ar: 'دير البلح', aliases: ['Deir al Balah', 'Deir Al-Balah', 'Deir el-Balah', 'Dair al-Balah', 'Middle Area'] },
  { en: 'Khan Younis', ar: 'خان يونس', aliases: ['Khan Yunis', 'Khan Younes', 'Khanyounis', 'خانيونس'] },
  { en: 'Rafah', ar: 'رفح', aliases: [] },
];

const ARABIC = /[؀-ۿ]/;

/**
 * Lower case, no diacritics or tatweel, one form of alef, ya and ta marbuta, "governorate" / "محافظة"
 * removed, punctuation as spaces, "&" as "and", spaces collapsed.
 */
export function normalisePlace(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // Latin accents; Arabic short vowels, shadda, hamza and madda marks
    .replace(/\u0640/g, '') // tatweel
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627') // alef forms → ا
    .replace(/[\u0649\u06CC]/g, '\u064A') // alef maqsura, Farsi ya → ي
    .replace(/\u06A9/g, '\u0643') // Farsi kaf → ك
    .replace(/\u0629/g, '\u0647') // ta marbuta → ه
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/و\s+ال/g, 'وال')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\bgovernorate\b|\bgov\b|محافظه/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LOOKUP: ReadonlyMap<string, Place> = new Map(
  DONOR_PLACES.flatMap(place => [place.en, place.ar, ...place.aliases].map(name => [normalisePlace(name), place] as const)),
);

/** The listed place a typed area or governorate names (the whole text, in any listed spelling), otherwise null. */
export function donorPlace(text: string | null | undefined): Place | null {
  if (typeof text !== 'string') return null;
  return LOOKUP.get(normalisePlace(text)) ?? null;
}

/**
 * The place name a donor may see for a typed area or governorate: the listed name (in Arabic when the text
 * is Arabic, otherwise in English) when the whole text is a listed place, otherwise null.
 */
export function donorPlaceName(text: string | null | undefined): string | null {
  const place = donorPlace(text);
  if (!place) return null;
  return ARABIC.test(text as string) ? place.ar : place.en;
}
