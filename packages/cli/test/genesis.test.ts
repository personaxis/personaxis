/**
 * Character cards as Genesis sources: the payload is found inside a PNG, and the card's fields reach the
 * model labelled, as one source it reads and cites.
 *
 * Until 2026-10-07 this file also pinned the heuristic builder ("ANY seed builds a valid spec"). That
 * builder is gone (H15): every field is authored by a model and checked stage by stage (`checkStage`, in
 * core's `genesis-author.test.ts`), and the whole document is validated before anything is written.
 */
import { describe, it, expect, afterEach } from "vitest";
import { deflateSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCardFromPng, importCharacterCard } from "@personaxis/core";

function pngWithText(keyword: string, payload: string): Buffer {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]); // CRC unchecked
  };
  const ihdr = chunk("IHDR", Buffer.alloc(13));
  const text = chunk("tEXt", Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.alloc(1), Buffer.from(Buffer.from(payload).toString("base64"), "latin1")]));
  const idat = chunk("IDAT", deflateSync(Buffer.alloc(1)));
  const iend = chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([magic, ihdr, text, idat, iend]);
}

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("character-card import", () => {
  it("extracts ccv3 and chara payloads; rejects non-card PNGs", () => {
    const card = { spec: "chara_card_v3", data: { name: "Vex", description: "a wary smuggler" } };
    const png = pngWithText("ccv3", JSON.stringify(card));
    const got = extractCardFromPng(png);
    expect(got?.spec).toBe("card-v3");
    expect((got?.json as { data: { name: string } }).data.name).toBe("Vex");
    expect(extractCardFromPng(pngWithText("comment", "hello"))).toBeNull();
    expect(extractCardFromPng(Buffer.from("not a png"))).toBeNull();
  });

  it("hands the model every filled field, labelled, and skips the empty ones", () => {
    dir = mkdtempSync(join(tmpdir(), "pxs-card-"));
    const path = join(dir, "vex.png");
    const card = { spec: "chara_card_v2", data: { name: "Vex", description: "a wary smuggler", personality: "  ", tags: ["noir", "space"] } };
    writeFileSync(path, pngWithText("chara", JSON.stringify(card)));

    const m = importCharacterCard(path);

    expect(m.format).toBe("card-v2");
    expect(m.text).toContain("Name:\nVex");
    expect(m.text).toContain("Description:\na wary smuggler");
    expect(m.text).toContain("Tags:\nnoir, space");
    expect(m.text).not.toContain("Personality:");
  });
});
