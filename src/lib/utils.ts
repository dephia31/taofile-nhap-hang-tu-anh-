import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function normalizeString(str: string): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\./g, ",") // Convert decimal dots to commas
    .replace(/[^a-z0-9,\s]/g, " ") // Keep alphanumeric, commas, and replace others with space
    .replace(/(\d)([a-z])/g, "$1 $2") // Add space between number and letter (e.g., 3f -> 3 f)
    .replace(/([a-z])(\d)/g, "$1 $2") // Add space between letter and number (e.g., f3 -> f 3)
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshteinDistance(a: string, b: string): number {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

export function processMattressDimensions(str: string): string {
  if (!str) return "";
  let s = str.toLowerCase().trim();

  const parseDim = (d: string) => {
    let val = 0;
    d = d.replace(/,/g, '.').trim();
    if (d.includes('m')) {
      const mParts = d.split('m');
      const m = parseFloat(mParts[0]) || 0;
      let cmStr = mParts[1] || "0";
      if (cmStr.length === 1) cmStr += "0"; 
      const cm = parseFloat(cmStr) || 0;
      val = m * 100 + cm;
    } else {
      val = parseFloat(d);
      if (val < 10) {
        val = val * 100;
      } else if (val >= 1000) {
        val = val / 10;
      }
    }
    return Math.round(val);
  };

  const normalizeDim = (v: number) => {
    if (v === 185 || v === 190) return 180;
    if (v === 195) return 200; // Ngoại lệ 195 -> 200 (giữ nguyên logic cũ hoặc chờ xác nhận)
    return v;
  };

  const dimRegex = /(\d+(?:[.,]\d+)?m?)\s*(?:x|\*|-|X)\s*(\d+(?:[.,]\d+)?m?)/;
  const match = s.match(dimRegex);
  
  if (match) {
    let v1 = parseDim(match[1]);
    let v2 = parseDim(match[2]);

    v1 = normalizeDim(v1);
    v2 = normalizeDim(v2);

    if (v1 > 0 && v2 > 0) {
      const min = Math.min(v1, v2);
      const max = Math.max(v1, v2);
      return `${min} x ${max}`;
    }
  }

  // Fallback for single dimensions like "1m2" or "120"
  const singleDimRegex = /(?:^|\s)([1-2]m[0-9]?|[1-2][0-9]{2})(?=\s|$|mm|cm|f)/g;
  const singleMatches = [...s.matchAll(singleDimRegex)];
  
  if (singleMatches.length >= 2) {
    let v1 = parseDim(singleMatches[0][1]);
    let v2 = parseDim(singleMatches[1][1]);
    v1 = normalizeDim(v1);
    v2 = normalizeDim(v2);
    if (v1 > 0 && v2 > 0) {
      const min = Math.min(v1, v2);
      const max = Math.max(v1, v2);
      return `${min} x ${max}`;
    }
  } else if (singleMatches.length === 1) {
    let v = parseDim(singleMatches[0][1]);
    v = normalizeDim(v);
    if (v > 0) {
      // If it's a standard width, assume length is 200
      if (v >= 80 && v <= 180 && v % 10 === 0) {
        return `${v} x 200`;
      }
      if (v === 200 || v === 220) {
        return `${v} x 200`;
      }
      return `${v}`;
    }
  }

  return normalizeString(str);
}

export function processThickness(str: string): string {
  if (!str) return "";
  let s = str.toUpperCase().trim();
  
  // Extract number and unit
  const numMatch = s.match(/(\d+(?:[.,]\d+)?)\s*(MM|CM|F|PHÂN|DEM)/i);
  if (numMatch) {
    let numStr = numMatch[1].replace(',', '.');
    let num = parseFloat(numStr);
    let unit = numMatch[2] ? numMatch[2].toUpperCase() : '';
    
    if (unit === 'DEM') {
      return `${num} DEM`;
    }
    
    if (unit === 'MM') {
      num = num / 10; 
    }
    
    if (num === 14) num = 15;
    else if (num === 2.5) num = 3;
    else if (num === 4.5) num = 5;
    else if (num === 7.5) num = 10;
    else if (num === 18) num = 20;
    else num = Math.round(num);
    
    return `${num}F`;
  }
  
  // Try to match just a number if it has "DÀY" or "DAY" before it
  const dayMatch = s.match(/(?:DÀY|DAY)\s*(\d+(?:[.,]\d+)?)/i);
  if (dayMatch) {
    let numStr = dayMatch[1].replace(',', '.');
    let num = parseFloat(numStr);
    if (num >= 40) num = num / 10;
    
    if (num === 14) num = 15;
    else if (num === 2.5) num = 3;
    else if (num === 4.5) num = 5;
    else if (num === 7.5) num = 10;
    else if (num === 18) num = 20;
    else num = Math.round(num);
    
    return `${num}F`;
  }

  // Fallback specific mappings
  if (s === '14F') return '15F';
  if (s === '18F') return '20F';
  if (s === '2.5F' || s === '2,5F') return '3F';
  if (s === '4.5F' || s === '4,5F') return '5F';
  if (s === '7.5F' || s === '7,5F') return '10F';
  
  return normalizeString(str);
}

const GENERIC_WORDS = [
  'nem', 'ep', 'deo', 'than', 'hoat', 'tinh', 'cao', 'su', 'eth',
  'bong', 'lo', 'xo', 'vai', 'gam', 'thun', 'lanh', 'mat', 'massage', 'chong', 
  'truot', 'thoang', 'khi', 'khang', 'khuan', 'gia', 're', 'cap', 'chinh', 
  'hang', 'tong', 'kho', 'dai', 'ly', 'si', 'le', 'kich', 'thuoc', 'do', 
  'day', 'phan', 'met', 'cm', 'mm', 'f', 'bong', 'gon', 'nhan', 'tao', 'loai', '1',
  'kim', 'cuong', 'thang', 'gap', 'tron', 'cuon', 'hop', 'va', 'cua', 'cho', 'mau',
  'trang', 'xanh', 'hong', 'xam', 'nau', 'den', 'vang', 'tim', 'do', 'bong', 'gon'
];

export function findBestMatch(
  extracted: { name: string; dimensions?: string; thickness?: string; rawName?: string },
  dbData: any[],
  nameKey: string
) {
  const normalizeWithSynonyms = (s: string) => {
    let res = normalizeString(s);
    res = res.replace(/\beth\b/g, "ep tong hop");
    res = res.replace(/\bsatin lua\b/g, "satin");
    return res;
  };

  const normName = normalizeWithSynonyms(extracted.name);
  const normDim = extracted.dimensions ? processMattressDimensions(extracted.dimensions) : "";
  const normThick = extracted.thickness ? processThickness(extracted.thickness) : "";
  const normRaw = normalizeWithSynonyms(extracted.rawName || "");

  if (!normRaw && !normName) return null;

  // 1. Exact match check
  for (const item of dbData) {
    const itemName = item[nameKey] || "";
    if (normalizeWithSynonyms(itemName) === normRaw) {
      return item;
    }
  }

  // Words that are longer than 1 character to avoid matching single letters
  const nameWords = normName.split(' ').filter(w => w.length > 1);
  
  // Identify mandatory keywords (non-generic words)
  const specificWords = nameWords.filter(w => !GENERIC_WORDS.includes(w));
  // If we have highly specific words (like brand names or unique models), they are mandatory
  const mandatoryWords = specificWords.length > 0 ? specificWords : nameWords;

  // Product Type Detection (Straight vs Foldable)
  // "gap" or "3" (as a whole word) indicates foldable. "thang" indicates straight.
  const isFoldableRegex = /\bgap\b|\b3\b/;
  const isStraightRegex = /\bthang\b/;
  
  const isFoldableExtracted = isFoldableRegex.test(normName);
  const isStraightExtracted = isStraightRegex.test(normName);

  const candidates = [];

  for (const item of dbData) {
    const itemName = item[nameKey] || "";
    const normalizedItem = normalizeWithSynonyms(itemName);
    
    // 2. Mandatory Keyword Check: At least one specific keyword must match
    let mandatoryMatched = false;
    if (mandatoryWords.length === 0) {
      mandatoryMatched = true;
    } else {
      // Stricter check: if we have specific words, at least one MUST match
      for (const word of mandatoryWords) {
        if (normalizedItem.includes(word)) {
          mandatoryMatched = true;
          break;
        }
      }
    }
    
    if (!mandatoryMatched) continue;

    // 2.1 Product Type Consistency Check
    const isFoldableItem = isFoldableRegex.test(normalizedItem);
    const isStraightItem = isStraightRegex.test(normalizedItem);

    // Cross-check: If invoice is one type, DB item cannot be the other
    if (isFoldableExtracted && isStraightItem) continue;
    if (isStraightExtracted && isFoldableItem) continue;
    
    // 2.2 Material Type Consistency Check (Foam vs PE vs Cao su vs Lo xo vs Ep Deo vs Ep Tong Hop)
    const isFoamExtracted = normName.includes('foam');
    const isPEExtracted = normName.includes('pe');
    const isCaoSuNonExtracted = normName.includes('cao su non');
    const isEpDeoExtracted = normName.includes('ep deo') || isCaoSuNonExtracted;
    const isCaoSuExtracted = normName.includes('cao su') && !isCaoSuNonExtracted;
    const isLoXoExtracted = normName.includes('lo xo');
    const isEpTongHopExtracted = normName.includes('ep tong hop');

    const isFoamItem = normalizedItem.includes('foam');
    const isPEItem = normalizedItem.includes('pe');
    const isCaoSuNonItem = normalizedItem.includes('cao su non');
    const isEpDeoItem = normalizedItem.includes('ep deo') || isCaoSuNonItem;
    const isCaoSuItem = normalizedItem.includes('cao su') && !isCaoSuNonItem;
    const isLoXoItem = normalizedItem.includes('lo xo');
    const isEpTongHopItem = normalizedItem.includes('ep tong hop');

    if (isFoamExtracted && !isFoamItem && (isPEItem || isCaoSuItem || isLoXoItem || isEpDeoItem || isEpTongHopItem)) continue;
    if (isPEExtracted && !isPEItem && (isFoamItem || isCaoSuItem || isLoXoItem || isEpDeoItem || isEpTongHopItem)) continue;
    if (isEpDeoExtracted && !isEpDeoItem && (isFoamItem || isPEItem || isCaoSuItem || isLoXoItem || isEpTongHopItem)) continue;
    if (isCaoSuExtracted && !isCaoSuItem && (isFoamItem || isPEItem || isLoXoItem || isEpDeoItem || isEpTongHopItem)) continue;
    if (isLoXoExtracted && !isLoXoItem && (isFoamItem || isPEItem || isCaoSuItem || isEpDeoItem || isEpTongHopItem)) continue;
    if (isEpTongHopExtracted && !isEpTongHopItem && (isFoamItem || isPEItem || isCaoSuItem || isLoXoItem || isEpDeoItem)) continue;

    // Cross-check: If invoice is one type, DB item cannot be another
    if (isEpDeoExtracted && isPEItem) continue;
    if (isPEExtracted && isEpDeoItem) continue;

    // Combine all values for attribute searching (like "Thuộc tính")
    const allValues = Object.values(item)
      .filter(v => v !== null && v !== undefined)
      .map(v => String(v)) // Keep original string to avoid losing '*' before processing
      .join(' | ');

    // Extract dimensions and thickness from the DB item name to compare apples to apples
    const itemDim = processMattressDimensions(itemName);
    const itemThick = processThickness(itemName);
    const allValuesDim = processMattressDimensions(allValues);
    const allValuesThick = processThickness(allValues);
    
    const normalizedAllValues = normalizeWithSynonyms(allValues);

    let score = 0;

    // 3. Dimension matching (STRICT)
    let dimMatch = false;
    if (normDim) {
      const normalizedDim = normalizeString(normDim);
      const dimNoSpace = normalizedDim.replace(/\s+/g, '');
      if (
        normalizedItem.includes(normalizedDim) || 
        normalizedItem.replace(/\s+/g, '').includes(dimNoSpace) ||
        itemDim === normDim ||
        allValuesDim === normDim ||
        normalizedAllValues.includes(normalizedDim) ||
        normalizedAllValues.replace(/\s+/g, '').includes(dimNoSpace)
      ) {
        score += 100;
        dimMatch = true;
      }
      
      // If dimension is provided but doesn't match, skip
      if (!dimMatch) continue;
    } else {
      dimMatch = true; // No dimension requested
    }

    // 4. Thickness matching (STRICT)
    let thickMatch = false;
    if (normThick) {
      const normalizedThick = normalizeString(normThick);
      const allValuesThickProcessed = processThickness(allValues);
      if (
        normalizedItem.includes(normalizedThick) ||
        itemThick === normThick ||
        allValuesThickProcessed === normThick ||
        normalizedAllValues.includes(normalizedThick)
      ) {
        score += 100;
        thickMatch = true;
      }
      
      // If thickness is provided but doesn't match, skip
      if (!thickMatch) continue;
    } else {
      thickMatch = true; // No thickness requested
    }

    // 5. Levenshtein distance and similarity
    const distance = levenshteinDistance(normRaw, normalizedItem);
    const maxLen = Math.max(normRaw.length, normalizedItem.length);
    const similarity = maxLen > 0 ? (1 - distance / maxLen) : 1;
    score += similarity * 50;

    // 6. Product Type Bonus
    if (isFoldableExtracted && isFoldableItem) score += 50;
    if (isStraightExtracted && isStraightItem) score += 50;

    // 7. Material Type Bonus
    if (isFoamExtracted && isFoamItem) score += 30;
    if (isPEExtracted && isPEItem) score += 30;
    if (isEpDeoExtracted && isEpDeoItem) score += 30;
    if (isCaoSuExtracted && isCaoSuItem) score += 30;
    if (isLoXoExtracted && isLoXoItem) score += 30;
    if (isEpTongHopExtracted && isEpTongHopItem) score += 30;

    // 8. Word matching bonus
    let matchedWords = 0;
    for (const word of nameWords) {
      if (normalizedItem.includes(word)) {
        matchedWords++;
        score += 10;
      }
    }

    candidates.push({ item, score, dimMatch, thickMatch });
  }

  if (candidates.length === 0) return null;

  // Sort candidates:
  // 1. Prioritize matching both dim and thick
  // 2. Then by total score (which includes similarity)
  candidates.sort((a, b) => {
    const aBoth = a.dimMatch && a.thickMatch ? 1 : 0;
    const bBoth = b.dimMatch && b.thickMatch ? 1 : 0;
    if (aBoth !== bBoth) return bBoth - aBoth;
    return b.score - a.score;
  });

  return candidates[0].item;
}
