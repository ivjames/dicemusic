// The minuet lookup table of the Musikalisches Würfelspiel K.516f (Simrock, 1793),
// as printed on the Princeton COS 126 assignment page and in the original:
// row = total of two dice (2..12), column = bar of the minuet (1..16), cell = measure number.
export const MINUET_TABLE = {
   2: [ 96,  22, 141,  41, 105, 122,  11,  30,  70, 121,  26,   9, 112,  49, 109,  14],
   3: [ 32,   6, 128,  63, 146,  46, 134,  81, 117,  39, 126,  56, 174,  18, 116,  83],
   4: [ 69,  95, 158,  13, 153,  55, 110,  24,  66, 139,  15, 132,  73,  58, 145,  79],
   5: [ 40,  17, 113,  85, 161,   2, 159, 100,  90, 176,   7,  34,  67, 160,  52, 170],
   6: [148,  74, 163,  45,  80,  97,  36, 107,  25, 143,  64, 125,  76, 136,   1,  93],
   7: [104, 157,  27, 167, 154,  68, 118,  91, 138,  71, 150,  29, 101, 162,  23, 151],
   8: [152,  60, 171,  53,  99, 133,  21, 127,  16, 155,  57, 175,  43, 168,  89, 172],
   9: [119,  84, 114,  50, 140,  86, 169,  94, 120,  88,  48, 166,  51, 115,  72, 111],
  10: [ 98, 142,  42, 156,  75, 129,  62, 123,  65,  77,  19,  82, 137,  38, 149,   8],
  11: [  3,  87, 165,  61, 135,  47, 147,  33, 102,   4,  31, 164, 144,  59, 173,  78],
  12: [ 54, 130,  10, 103,  28,  37, 106,   5,  35,  20, 108,  92,  12, 124,  44, 131],
};

export const BARS = 16;
export const MEASURE_COUNT = 176;

/** Measure number for a bar (0-based) and a dice total (2..12). */
export function measureFor(bar, sum) {
  if (!Number.isInteger(bar) || bar < 0 || bar >= BARS) throw new RangeError(`bar out of range: ${bar}`);
  const row = MINUET_TABLE[sum];
  if (!row) throw new RangeError(`dice total out of range: ${sum}`);
  return row[bar];
}

/** The eleven candidate measures for one bar, in dice-total order 2..12. */
export function optionsFor(bar) {
  const out = [];
  for (let s = 2; s <= 12; s++) out.push(MINUET_TABLE[s][bar]);
  return out;
}
