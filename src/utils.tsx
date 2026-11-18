import { Clipboard, environment } from "@raycast/api";
import fs from "node:fs/promises";
import path from "node:path";

export interface QuickMathArguments {
  latex: string | undefined;
}

const OUTPUT_DIRECTORY = path.join(environment.supportPath, "output");
const CLIPBOARD_PATH = path.join(OUTPUT_DIRECTORY, "formula.png");

export async function copyPngToClipboard(image: Buffer) {
  await fs.mkdir(OUTPUT_DIRECTORY, { recursive: true });

  const temporaryPath = path.join(OUTPUT_DIRECTORY, `formula-${process.pid}-${Date.now().toString(36)}.tmp`);

  try {
    await fs.writeFile(temporaryPath, image);
    await fs.rename(temporaryPath, CLIPBOARD_PATH);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }

  const fileContent: Clipboard.Content = { file: CLIPBOARD_PATH };
  await Clipboard.copy(fileContent);
}
