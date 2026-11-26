const HEX_64 = /^[0-9a-f]{64}$/;
const TXID = /^0x[0-9a-fA-F]{64}$/;
const HEX_VALUE = /^[0-9a-f]+$/;
const DECIMAL_VALUE = /^\d+$/;
const MAX_MEMO_LENGTH = 4_096;
const MAX_RANDOM_LENGTH = 128;
const MAX_DECIMAL_UINT256_LENGTH = 78;
const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_REMOTE_SCAN_NOTES = 20_000;

export const remoteScanNoteLimitError = (): Error =>
  new Error(
    "Remote scan note limit exceeded; increase LIGHT_SCAN_MAX_NOTES or scan locally.",
  );

export type RemoteScanNote = {
  tree: number;
  leaf: number;
  hash: string;
  blockNumber: number;
  txid: string;
  kind: "shield" | "transact";
  commitmentType: string;
  tokenHash: string;
  value: string;
  random: string;
  senderRandom: string | null;
  memo: string | null;
  nullifier: string;
  spent: boolean;
};

export type RemoteScanResult = {
  notes: RemoteScanNote[];
  nextFromBlock: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (detail: string): Error =>
  new Error(`Remote scan returned an invalid result: ${detail}.`);

const nonNegativeInteger = (
  value: unknown,
  field: string,
): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalid(`${field} must be a non-negative integer`);
  }
  return value as number;
};

const hexString = (
  value: unknown,
  field: string,
  pattern: RegExp,
  maxLength?: number,
): string => {
  if (
    typeof value !== "string" ||
    (maxLength !== undefined && value.length > maxLength) ||
    !pattern.test(value)
  ) {
    throw invalid(`${field} has an invalid encoding`);
  }
  return value;
};

const optionalRandom = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  return hexString(value, field, HEX_VALUE, MAX_RANDOM_LENGTH);
};

const optionalMemo = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MAX_MEMO_LENGTH) {
    throw invalid("memo is too large or has an invalid type");
  }
  return value;
};

const uint256String = (value: unknown, field: string): string => {
  if (
    typeof value !== "string" ||
    value.length > MAX_DECIMAL_UINT256_LENGTH ||
    !DECIMAL_VALUE.test(value)
  ) {
    throw invalid(`${field} has an invalid value`);
  }
  if (BigInt(value) > MAX_UINT256) {
    throw invalid(`${field} has an invalid value`);
  }
  return value;
};

const normalizeNote = (value: unknown, index: number): RemoteScanNote => {
  if (!isRecord(value)) {
    throw invalid(`note ${index} must be an object`);
  }
  if (value.kind !== "shield" && value.kind !== "transact") {
    throw invalid(`note ${index} has an invalid kind`);
  }
  if (
    value.commitmentType !== "ShieldCommitment" &&
    value.commitmentType !== "TransactCommitmentV2"
  ) {
    throw invalid(`note ${index} has an invalid commitment type`);
  }
  const expectedKind =
    value.commitmentType === "ShieldCommitment" ? "shield" : "transact";
  if (value.kind !== expectedKind) {
    throw invalid(`note ${index} kind does not match its commitment type`);
  }
  if (typeof value.spent !== "boolean") {
    throw invalid(`note ${index} has an invalid spent flag`);
  }
  return {
    tree: nonNegativeInteger(value.tree, `note ${index} tree`),
    leaf: nonNegativeInteger(value.leaf, `note ${index} leaf`),
    hash: hexString(value.hash, `note ${index} hash`, HEX_64),
    blockNumber: nonNegativeInteger(
      value.blockNumber,
      `note ${index} blockNumber`,
    ),
    txid: hexString(value.txid, `note ${index} txid`, TXID),
    kind: value.kind,
    commitmentType: value.commitmentType,
    tokenHash: hexString(
      value.tokenHash,
      `note ${index} tokenHash`,
      HEX_64,
    ),
    value: uint256String(value.value, `note ${index} value`),
    random: hexString(
      value.random,
      `note ${index} random`,
      HEX_VALUE,
      MAX_RANDOM_LENGTH,
    ),
    senderRandom: optionalRandom(
      value.senderRandom,
      `note ${index} senderRandom`,
    ),
    memo: optionalMemo(value.memo),
    nullifier: hexString(
      value.nullifier,
      `note ${index} nullifier`,
      HEX_64,
    ),
    spent: value.spent,
  };
};

export const normalizeRemoteScanResult = (
  value: unknown,
  maxNotes: number,
): RemoteScanResult => {
  if (!isRecord(value) || !Array.isArray(value.notes)) {
    throw invalid("the top-level shape is not recognized");
  }
  if (value.notes.length > maxNotes) {
    throw remoteScanNoteLimitError();
  }
  const nextFromBlock =
    value.nextFromBlock === null
      ? null
      : nonNegativeInteger(
          value.nextFromBlock,
          "nextFromBlock",
        );
  return {
    notes: Array.from(value.notes, (entry, index) =>
      normalizeNote(entry, index),
    ),
    nextFromBlock,
  };
};
