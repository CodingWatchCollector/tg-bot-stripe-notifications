import { describe, expect, test } from "vitest";
import { PRODUCTS, productFor } from "../src/domain/products";
import { PRODUCTS_FIXTURE } from "./support/seed";

describe("productFor", () => {
  test("a Pack product carries its name and lesson count", () => {
    expect(productFor(PRODUCTS_FIXTURE, "plink_t4")).toStrictEqual({ name: "Індивідуальний пакет 4", lessons: 4 });
  });

  test("a name-only product has no lessons key", () => {
    expect(productFor(PRODUCTS_FIXTURE, "plink_club")).toStrictEqual({ name: "Клуб B2/C1 — поурочно" });
  });

  test.each([["plink_other"], [null], ["toString"], ["__proto__"]])("%s is not a product", (id) => {
    expect(productFor(PRODUCTS_FIXTURE, id)).toBeNull();
  });
});

describe("PRODUCTS", () => {
  test("is exactly the eight live Payment Links", () => {
    expect(PRODUCTS).toStrictEqual({
      plink_1UJ8e4IyK0Zo9wWeVJpaqnBn: { name: "Індивідуальне — поурочно", lessons: 1 },
      plink_1UJ8fEIyK0Zo9wWeHbvnn2g5: { name: "Індивідуальний пакет 4", lessons: 4 },
      plink_1UJ8fuIyK0Zo9wWeABL1z5yA: { name: "Індивідуальний пакет 8", lessons: 8 },
      plink_1UJ8iIIyK0Zo9wWepPrK5fu1: { name: "Duo — поурочно", lessons: 1 },
      plink_1UJ8ipIyK0Zo9wWei6tQuH1I: { name: "Duo — пакет 4", lessons: 4 },
      plink_1UJ8gdIyK0Zo9wWes5StiR2p: { name: "Клуб B2/C1 — поурочно" },
      plink_1UJ8hfIyK0Zo9wWeDIq7AoVE: { name: "Клуб B2/C1 — пакет 4" },
      plink_1UJ8jOIyK0Zo9wWe9L2ZFqCk: { name: "Книжковий клуб B2/C1 — пакет" },
    });
  });
});
