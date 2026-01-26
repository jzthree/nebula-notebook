const CELL_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const CELL_ID_LENGTH = 6;

export const generateCellId = (): string => {
  const alphabet = CELL_ID_ALPHABET;
  const length = CELL_ID_LENGTH;
  let id = '';

  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < length; i += 1) {
      id += alphabet[bytes[i] % alphabet.length];
    }
    return id;
  }

  for (let i = 0; i < length; i += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return id;
};
