import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';

export type AgencyRow = {
  account_name: string;
  Industry: string;
  'What do they sell?'?: string;
};

export type ExampleRow = {
  Product: string;
  'Ad Link'?: string;
  Ad?: string;
  Copy?: string;
  Headline?: string;
  Description?: string;
  Analysis?: string;
  Improvement?: string;
  'Creative Analysis'?: string;
  'Creative Improvements'?: string;
  'Active Since'?: string;
};

const root = process.cwd();

export async function loadCsv<T>(relativePath: string): Promise<T[]> {
  const filePath = path.join(root, relativePath);
  const content = await readFile(filePath, 'utf8');
  return parse(content, { columns: true, skip_empty_lines: true, trim: true }) as T[];
}

export async function loadAgencyAccounts(): Promise<AgencyRow[]> {
  return loadCsv<AgencyRow>('meta-ad-library/Agency Accounts Overview.csv');
}

export async function loadStaticExamples(): Promise<ExampleRow[]> {
  return loadCsv<ExampleRow>('meta-ad-library/Static Ad Library example.csv');
}

export async function loadVideoExamples(): Promise<ExampleRow[]> {
  return loadCsv<ExampleRow>('meta-ad-library/Meta Video Ad Library example.csv');
}

export function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
}
