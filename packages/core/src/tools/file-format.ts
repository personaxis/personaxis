/**
 * `E102`: a file whose name promises a format its content is not.
 *
 * Measured on 2026-09-21. Asked for a design document, a playable prototype, a levels file and a one page
 * pitch, a persona delivered all of them and wrote the pitch into `pitch.pdf` as plain UTF-8 text. The words
 * were right. The name was a lie, and nothing said so: the tool answered `wrote 632 bytes`, the persona
 * closed the job reporting "One-page pitch (pitch.pdf)", and whoever opened that file in a PDF reader would
 * have seen nothing. The persona never learned it had failed.
 *
 * The check is against the first BYTES rather than a list of forbidden extensions, so a file that really does
 * carry what its name promises never warns, and the rule never has to guess what somebody meant.
 *
 * It warns and does not block, on purpose. Refusing a write because of its name would get in the way the day
 * somebody is right, and a refused call spends a step of the budget on something that is not an error.
 */

/**
 * What each extension's content has to start with.
 *
 * Only formats with a signature worth checking. `.zip` and the three Office formats share one because those
 * files ARE zips, which is also why a `.docx` written as text is exactly as broken as a `.pdf` written as
 * text, and catching one without the other would be arbitrary.
 */
const SIGNATURES: ReadonlyArray<readonly [readonly string[], string, readonly number[]]> = [
  [[".pdf"], "a PDF", [0x25, 0x50, 0x44, 0x46]], // %PDF
  [[".png"], "a PNG image", [0x89, 0x50, 0x4e, 0x47]],
  [[".jpg", ".jpeg"], "a JPEG image", [0xff, 0xd8, 0xff]],
  [[".gif"], "a GIF image", [0x47, 0x49, 0x46, 0x38]], // GIF8
  [[".zip", ".docx", ".xlsx", ".pptx"], "a zip archive", [0x50, 0x4b]], // PK
  [[".mp3"], "an MP3", [0x49, 0x44, 0x33]], // ID3
];

/** The extension of a path, lowercased, including the dot. Empty when it has none. */
function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * The warning this write earns, or null when the name and the content agree.
 *
 * `content` is the string the tool was handed. It is compared by code unit rather than by decoding to bytes
 * because every signature here is ASCII or a single high byte, and a string carrying a real PDF would still
 * start with the same four characters.
 */
export function formatMismatch(path: string, content: string): string | null {
  const ext = extensionOf(path);
  if (!ext) return null;
  const known = SIGNATURES.find(([exts]) => exts.includes(ext));
  if (!known) return null;
  const [, what, signature] = known;
  const matches = signature.every((byte, index) => content.charCodeAt(index) === byte);
  if (matches) return null;
  return (
    `warning: the name says ${ext} but the content is not ${what}, so an application that opens ${ext} files ` +
    `will not read it. Name it .md or .txt if it is text, or produce a real ${ext.slice(1)} file.`
  );
}
