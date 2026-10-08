export type PackSize = 1 | 4 | 8;
export interface Product {
  name: string;
  lessons?: PackSize;
}
export type Products = Readonly<Record<string, Product>>;

export const PRODUCTS: Products = {
  plink_1UJ8e4IyK0Zo9wWeVJpaqnBn: { name: "Індивідуальне — поурочно", lessons: 1 },
  plink_1UJ8fEIyK0Zo9wWeHbvnn2g5: { name: "Індивідуальний пакет 4", lessons: 4 },
  plink_1UJ8fuIyK0Zo9wWeABL1z5yA: { name: "Індивідуальний пакет 8", lessons: 8 },
  plink_1UJ8iIIyK0Zo9wWepPrK5fu1: { name: "Duo — поурочно", lessons: 1 },
  plink_1UJ8ipIyK0Zo9wWei6tQuH1I: { name: "Duo — пакет 4", lessons: 4 },
  plink_1UJ8gdIyK0Zo9wWes5StiR2p: { name: "Клуб B2/C1 — поурочно" },
  plink_1UJ8hfIyK0Zo9wWeDIq7AoVE: { name: "Клуб B2/C1 — пакет 4" },
  plink_1UJ8jOIyK0Zo9wWe9L2ZFqCk: { name: "Книжковий клуб B2/C1 — пакет" },
};

export const productFor = (products: Products, paymentLinkId: string | null): Product | null =>
  paymentLinkId !== null && Object.hasOwn(products, paymentLinkId) ? (products[paymentLinkId] ?? null) : null;
