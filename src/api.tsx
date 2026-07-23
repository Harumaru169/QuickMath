import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TEX_BIN = "/Library/TeX/texbin";
const LATEX_PATH = path.join(TEX_BIN, "latex");
const DVIPNG_PATH = path.join(TEX_BIN, "dvipng");
const PROCESS_TIMEOUT_MS = 8_000;
const MAX_PROCESS_OUTPUT = 1024 * 1024;

type ForegroundColor = "Black" | "White";

const FOREGROUND_SPECS: Record<ForegroundColor, string> = {
  Black: "rgb 0 0 0",
  White: "rgb 1 1 1",
};

export class LatexRenderError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "LatexRenderError";
  }
}

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export async function getPreviewImage(searchText: string, preamble: string, signal?: AbortSignal) {
  const latex = normalizeLatex(searchText);
  const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "quick-latex-"));

  try {
    await checkDependencies();
    const dviPath = await compileToDvi(latex, preamble, workDirectory, signal);
    const light = await convertDviToPng(dviPath, workDirectory, "preview-light.png", "Black", signal);
    const dark = await convertDviToPng(dviPath, workDirectory, "preview-dark.png", "White", signal);

    return {
      source: {
        light: toPngDataUrl(light),
        dark: toPngDataUrl(dark),
      },
    };
  } finally {
    await fs.rm(workDirectory, { recursive: true, force: true });
  }
}

export async function renderFormula(
  searchText: string,
  preamble: string,
  foreground: ForegroundColor = "Black",
  signal?: AbortSignal
) {
  const latex = normalizeLatex(searchText);
  const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "quick-latex-"));

  try {
    await checkDependencies();
    const dviPath = await compileToDvi(latex, preamble, workDirectory, signal);
    return await convertDviToPng(dviPath, workDirectory, "formula.png", foreground, signal);
  } finally {
    await fs.rm(workDirectory, { recursive: true, force: true });
  }
}

async function checkDependencies() {
  await requireExecutable(
    LATEX_PATH,
    `LaTeX was not found at ${LATEX_PATH}. Install BasicTeX or MacTeX and try again.`
  );
  await requireExecutable(
    DVIPNG_PATH,
    `dvipng was not found at ${DVIPNG_PATH}. Install it with: sudo ${path.join(TEX_BIN, "tlmgr")} install dvipng`
  );
}

async function requireExecutable(executablePath: string, message: string) {
  try {
    await fs.access(executablePath, fsConstants.X_OK);
  } catch {
    throw new LatexRenderError(message);
  }
}

async function compileToDvi(latex: string, preamble: string, workDirectory: string, signal?: AbortSignal) {
  const texPath = path.join(workDirectory, "formula.tex");
  await fs.writeFile(texPath, buildDocument(latex, preamble), "utf8");

  await runCommand(
    LATEX_PATH,
    [
      "-no-shell-escape",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-file-line-error",
      `-output-directory=${workDirectory}`,
      texPath,
    ],
    workDirectory,
    signal,
    "LaTeX could not render this formula or custom preamble."
  );

  return path.join(workDirectory, "formula.dvi");
}

async function convertDviToPng(
  dviPath: string,
  workDirectory: string,
  outputName: string,
  foreground: ForegroundColor,
  signal?: AbortSignal
) {
  const outputPath = path.join(workDirectory, outputName);

  await runCommand(
    DVIPNG_PATH,
    ["-D", "512", "-T", "tight", "-bg", "Transparent", "-fg", FOREGROUND_SPECS[foreground], "-o", outputPath, dviPath],
    workDirectory,
    signal,
    "dvipng could not create the PNG image."
  );

  return fs.readFile(outputPath);
}

function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  fallbackMessage: string
) {
  return new Promise<void>((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd,
        signal,
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: MAX_PROCESS_OUTPUT,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }

        if (error.name === "AbortError") {
          reject(error);
          return;
        }

        const output = [stdout, stderr].filter(Boolean).join("\n");
        const detail = extractLatexError(output);
        const message =
          "killed" in error && error.killed
            ? `Rendering timed out after ${PROCESS_TIMEOUT_MS / 1000} seconds.`
            : fallbackMessage;
        reject(new LatexRenderError(message, detail));
      }
    );
  });
}

function normalizeLatex(searchText: string) {
  return searchText.trim() === "" ? "LaTeX" : searchText;
}

function buildDocument(latex: string, preamble: string) {
  const customPreamble = normalizePreamble(preamble);
  const customPreambleBlock = customPreamble === "" ? "" : `${customPreamble}\n`;

  return `\\documentclass[12pt]{article}
\\usepackage{amsmath}
\\usepackage{amssymb}
${customPreambleBlock}\\pagestyle{empty}
\\begin{document}
\\thispagestyle{empty}
\\[
${latex}
\\]
\\end{document}
`;
}

function normalizePreamble(preamble: string) {
  return preamble.replace(/\r\n?/g, "\n").trim();
}

function extractLatexError(output: string) {
  const lines = output.split(/\r?\n/);
  const errorIndex = lines.findIndex((line) => line.startsWith("!") || /formula\.tex:\d+:/.test(line));

  if (errorIndex === -1) {
    return undefined;
  }

  return lines
    .slice(errorIndex, errorIndex + 3)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function toPngDataUrl(image: Buffer) {
  return `data:image/png;base64,${image.toString("base64")}`;
}
