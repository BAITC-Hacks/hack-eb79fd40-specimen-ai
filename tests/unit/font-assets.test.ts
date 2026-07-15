import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fontkit from "@pdf-lib/fontkit";
import { describe, expect, it } from "vitest";

const KAZAKH = "Әә Ғғ Ққ Ңң Өө Ұұ Үү Һһ Іі";
const RUSSIAN = "Аа Бб Вв Ёё Жж Йй Цц Чч Шш Щщ Ъъ Ыы Ьь Ээ Юю Яя";
const UPSTREAM_COMMIT = "01848217e069afd63f72175b9b075ad9e07b8df8";

const ASSETS = [
  {
    path: "assets/fonts/Lora-Variable.ttf",
    family: "Lora",
    style: "Regular",
    digest: "822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7",
  },
  {
    path: "assets/fonts/Lora-Italic-Variable.ttf",
    family: "Lora",
    style: "Italic",
    digest: "22d8d8854b53807aa664ca34f2031a9ed57a1d0dea296b8b96cdd3aad937a2b3",
  },
  {
    path: "assets/fonts/IBMPlexSans-Variable.ttf",
    family: "IBM Plex Sans",
    style: "Regular",
    digest: "3b031aa4216174205bd8471f88a49b91f093169e9e87bd5262242bc5967fe2e3",
  },
] as const;

describe("local font assets", () => {
  it.each(ASSETS)(
    "$path has pinned bytes, expected metadata, and Russian/Kazakh glyphs",
    ({ path, family, style, digest }) => {
      const bytes = readFileSync(path);
      const font = fontkit.create(bytes);

      expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
      expect(font.familyName).toBe(family);
      expect(font.subfamilyName).toBe(style);
      for (const character of `${KAZAKH} ${RUSSIAN}`.replaceAll(" ", "")) {
        expect(font.hasGlyphForCodePoint(character.codePointAt(0)!)).toBe(true);
      }
    },
  );

  it("pins official source URLs, hashes and OFL licenses", () => {
    const provenance = readFileSync("assets/fonts/README.md", "utf8");
    expect(provenance).toContain(`google/fonts\` at commit\n\`${UPSTREAM_COMMIT}`);
    for (const asset of ASSETS) {
      expect(provenance).toContain(`\`${asset.path.split("/").at(-1)}\``);
      expect(provenance).toContain(asset.digest);
    }
    expect(provenance.match(/raw\.githubusercontent\.com\/google\/fonts\//gu)).toHaveLength(3);
    expect(readFileSync("assets/fonts/LICENSE-Lora-OFL.txt", "utf8")).toContain(
      'Reserved Font Name "Lora"',
    );
    expect(
      readFileSync("assets/fonts/LICENSE-IBM-Plex-Sans-OFL.txt", "utf8"),
    ).toContain('Reserved Font Name "Plex"');
  });

  it("wires every local font into CSS and leaves no external runtime source", () => {
    const css = readFileSync("app/globals.css", "utf8");
    for (const asset of ASSETS) {
      expect(css).toContain(`../${asset.path}`);
    }
    expect(css).toContain('--serif: "Lora"');
    expect(css).toContain('--sans: "IBM Plex Sans"');
    expect(css.match(/font-display: swap/gu)).toHaveLength(3);
    expect(css).not.toMatch(/https?:|fonts\.googleapis|fonts\.gstatic|@import/iu);
    expect(readFileSync("app/layout.tsx", "utf8")).not.toMatch(/next\/font/iu);
  });
});
