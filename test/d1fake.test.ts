import { beforeEach, describe, expect, test } from "vitest";
import { createD1Fake, type D1Fake } from "./support/d1";
import { addStudent } from "./support/seed";

let fake: D1Fake;
beforeEach(() => {
  fake = createD1Fake();
});

const ORDER = "d1 fake: placeholders must be ?1..?n in order of first appearance";
const names = () => fake.raw.all("SELECT name FROM students ORDER BY id").map((r) => r.name);

describe("placeholder enforcement", () => {
  const swapped = () => fake.d1.prepare("SELECT * FROM students WHERE id = ?2 AND name = ?1").bind("A", 1);
  const bare = () => fake.d1.prepare("SELECT * FROM students WHERE id = ?").bind(1);
  const tooMany = () => fake.d1.prepare("SELECT * FROM students WHERE id = ?1").bind(1, 2);
  const tooFew = () => fake.d1.prepare("SELECT * FROM students WHERE id = ?1 AND name = ?2").bind(1);
  const gap = () => fake.d1.prepare("SELECT * FROM students WHERE id = ?1 AND name = ?3").bind(1, "A", "B");

  test.each([
    ["first", (s: ReturnType<typeof swapped>) => s.first()],
    ["all", (s: ReturnType<typeof swapped>) => s.all()],
    ["run", (s: ReturnType<typeof swapped>) => s.run()],
    ["batch", (s: ReturnType<typeof swapped>) => fake.d1.batch([s] as never)],
  ])("%s rejects out-of-order placeholders", async (_m, call) => {
    await expect(call(swapped())).rejects.toThrow(ORDER);
  });

  test("a bare ? is rejected", async () => {
    await expect(bare().first()).rejects.toThrow(ORDER);
  });

  test("a gap in the numbering is rejected", async () => {
    await expect(gap().first()).rejects.toThrow(ORDER);
  });

  test("a bound value count that differs is rejected", async () => {
    await expect(tooMany().first()).rejects.toThrow("d1 fake: expected 1 bound values, got 2");
    await expect(tooFew().all()).rejects.toThrow("d1 fake: expected 2 bound values, got 1");
    await expect(fake.d1.batch([tooMany()] as never)).rejects.toThrow("d1 fake: expected 1 bound values, got 2");
  });

  test("conforming statements run, including a repeated ?1", async () => {
    addStudent(fake, "Olena");
    const repeated = fake.d1.prepare("SELECT name FROM students WHERE name = ?1 OR name_key = ?1 OR id = ?2").bind("Olena", 1);
    expect(await repeated.first()).toEqual({ name: "Olena" });
    expect(await fake.d1.prepare("SELECT name FROM students").first()).toEqual({ name: "Olena" });
  });

  test("raw.run and raw.all are not checked", () => {
    addStudent(fake, "Olena");
    expect(() => fake.raw.run("UPDATE students SET name = ?2 WHERE id = ?1", "X", 1)).not.toThrow();
  });
});

describe("beforeNextBatch", () => {
  test("runs once, during the first batch only", async () => {
    let calls = 0;
    fake.beforeNextBatch(() => void calls++);
    await fake.d1.batch([]);
    await fake.d1.batch([]);
    expect(calls).toBe(1);
  });

  test("its write survives a batch that rolls back", async () => {
    fake.beforeNextBatch(() => fake.raw.run("INSERT INTO students(name, name_key, created_at) VALUES ('Hook', 'hook', 't')"));
    const dup = fake.d1.prepare("INSERT INTO students(name, name_key, created_at) VALUES (?1, ?2, 't')").bind("Dup", "dup");
    const bad = fake.d1.prepare("INSERT INTO students(name, name_key, created_at) VALUES (?1, ?2, 't')").bind("Dup 2", "dup");
    await expect(fake.d1.batch([dup, bad] as never)).rejects.toThrow();
    expect(names()).toEqual(["Hook"]);
  });

  test("a hook that batches does not loop", async () => {
    let calls = 0;
    fake.beforeNextBatch(() => {
      calls++;
      void fake.d1.batch([]);
    });
    await expect(fake.d1.batch([])).resolves.toEqual([]);
    expect(calls).toBe(1);
  });

  test("runs before an armed batch failure", async () => {
    let ran = false;
    fake.beforeNextBatch(() => void (ran = true));
    fake.failNext("batch");
    await expect(fake.d1.batch([])).rejects.toThrow("d1 fake: injected failure");
    expect(ran).toBe(true);
  });
});
