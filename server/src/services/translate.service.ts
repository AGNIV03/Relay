// Machine translation via Google's public (no-key) translate endpoint. Translates
// whole lines/sentences (not word-by-word), auto-detecting the source language.

const UA = "StreamSelfHosted/1.0 (+https://github.com/AGNIV03/stream)";

export interface TranslateResult {
  lang: string | null; // detected source language
  text: string | null; // translated text (newlines preserved)
}

/** Split text on line boundaries into chunks under `maxLen` chars (URL limits). */
function chunk(text: string, maxLen: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur && cur.length + line.length + 1 > maxLen) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) out.push(cur);
  return out;
}

export async function translateText(text: string, target = "en"): Promise<TranslateResult> {
  const trimmed = text.trim();
  if (!trimmed) return { lang: null, text: null };

  let translated = "";
  let lang: string | null = null;
  for (const part of chunk(trimmed, 1500)) {
    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=` +
      encodeURIComponent(part);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": UA }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`translate ${res.status}`);
    // Shape: [ [ [translatedSeg, originalSeg, ...], ... ], _, "<detected-lang>", ... ]
    const data = (await res.json()) as [Array<[string, string]>, unknown, string];
    lang = lang ?? data[2] ?? null;
    for (const seg of data[0] ?? []) translated += seg[0] ?? "";
  }
  return { lang, text: translated };
}
