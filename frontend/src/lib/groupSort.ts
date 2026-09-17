import { Book, BookGroup } from "../api/client";

// "2013" -> 2013; missing/non-numeric (a handful of ABS items have no
// publishedYear at all) sorts to the very end regardless of direction.
export function yearOf(b: Book): number {
  const y = b.publishedYear ? parseInt(b.publishedYear, 10) : NaN;
  return Number.isFinite(y) ? y : -Infinity;
}

export function latestYear(g: BookGroup): number {
  return g.books.reduce((max, b) => Math.max(max, yearOf(b)), -Infinity);
}

export const nameSort: (a: BookGroup, b: BookGroup) => number = (a, b) => a.name.localeCompare(b.name);

export const countSort: (a: BookGroup, b: BookGroup) => number = (a, b) =>
  b.books.length - a.books.length || nameSort(a, b);

export const latestSort: (a: BookGroup, b: BookGroup) => number = (a, b) =>
  latestYear(b) - latestYear(a) || nameSort(a, b);
