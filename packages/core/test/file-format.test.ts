/**
 * `E102`: a file whose name promises a format its content is not.
 *
 * The case this exists for is real and dated. On 2026-09-21, asked for six deliverables, a persona produced
 * all six and wrote the pitch into `pitch.pdf` as plain UTF-8 text, then closed the job reporting it as
 * delivered. Nothing in the runtime said otherwise, so the persona could not know it had failed and whoever
 * opened that file would have seen nothing.
 *
 * What these cases hold is the shape of the rule rather than one file name: warn on the mismatch, stay quiet
 * when the content really is what the name says, and stay quiet on everything else. A rule that fires on the
 * extension alone would warn on a real PDF too, and a warning that is wrong half the time is a warning people
 * learn to scroll past.
 */
import { describe, expect, it } from "vitest";
import { formatMismatch } from "../src/tools/file-format.js";

describe("a name that promises a format the content is not", () => {
  it("warns on the file that started this: a pitch written as text and called .pdf", () => {
    const warning = formatMismatch("pitch.pdf", "Frog Catcher\n\nA simple, charming game where you catch flies.\n");
    expect(warning).not.toBeNull();
    // The three things the persona needs to act: what the name promised, that the content is not it, and
    // what to do instead. A warning that only says something is wrong makes the reader guess.
    expect(warning).toContain(".pdf");
    expect(warning).toContain("will not read it");
    expect(warning).toContain(".md");
  });

  it("says nothing when the content really is a PDF", () => {
    expect(formatMismatch("report.pdf", "%PDF-1.7\n1 0 obj\n")).toBeNull();
  });

  it("says nothing about the formats we do not check", () => {
    expect(formatMismatch("game.md", "# Frog Catcher")).toBeNull();
    expect(formatMismatch("levels.json", '{"levels":[]}')).toBeNull();
    expect(formatMismatch("index.html", "<!doctype html>")).toBeNull();
    expect(formatMismatch("notes", "no extension at all")).toBeNull();
    expect(formatMismatch(".gitignore", "node_modules")).toBeNull();
  });

  it("catches the office formats, which are zips and break exactly the same way", () => {
    expect(formatMismatch("report.docx", "Quarterly report\n")).not.toBeNull();
    expect(formatMismatch("numbers.xlsx", "a,b,c\n")).not.toBeNull();
    // `PK` is what a real one starts with, zip being what those files are.
    expect(formatMismatch("report.docx", "PK\u0003\u0004rest of the archive")).toBeNull();
  });

  it("catches the image formats, and leaves a real one alone", () => {
    expect(formatMismatch("logo.png", "a description of a logo")).not.toBeNull();
    expect(formatMismatch("photo.jpeg", "not a photo")).not.toBeNull();
    expect(formatMismatch("logo.png", "\u0089PNG\r\n\u001a\n")).toBeNull();
  });

  it("reads the extension off the file name, not off the folders above it", () => {
    // A directory with a dot in it used to be the easy way to get this wrong.
    expect(formatMismatch("my.pdf.files/game.md", "# Frog Catcher")).toBeNull();
    expect(formatMismatch("deep/folder/pitch.PDF", "still text")).not.toBeNull();
    expect(formatMismatch("C:\\work\\pitch.pdf", "still text")).not.toBeNull();
  });

  it("is not fooled by the signature appearing later in the file", () => {
    // Anywhere but the start is not a PDF, and a check that searched the whole content would pass this.
    expect(formatMismatch("notes.pdf", "This document explains %PDF headers.")).not.toBeNull();
  });

  it("says nothing about an empty file, because there is nothing to disagree with yet", () => {
    // `write_file` with empty content is how a placeholder gets made, and warning there would be noise.
    expect(formatMismatch("placeholder.md", "")).toBeNull();
  });
});
