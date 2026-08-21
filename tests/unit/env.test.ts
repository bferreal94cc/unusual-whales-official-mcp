import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { parseEnvFile, loadEnv } from "../../src/env.js"

describe("parseEnvFile", () => {
  it("parses simple key/value pairs", () => {
    expect(parseEnvFile("UW_API_KEY=abc123")).toEqual({ UW_API_KEY: "abc123" })
  })

  it("ignores blank lines and comments", () => {
    const parsed = parseEnvFile("# a comment\n\nUW_API_KEY=abc123\n  # indented\n")
    expect(parsed).toEqual({ UW_API_KEY: "abc123" })
  })

  it("strips surrounding quotes and inline comments", () => {
    expect(parseEnvFile('A="quoted value"')).toEqual({ A: "quoted value" })
    expect(parseEnvFile("B='single'")).toEqual({ B: "single" })
    expect(parseEnvFile("C=value # trailing note")).toEqual({ C: "value" })
  })

  it("supports the export prefix", () => {
    expect(parseEnvFile("export UW_API_KEY=abc123")).toEqual({ UW_API_KEY: "abc123" })
  })

  it("keeps '=' inside values", () => {
    expect(parseEnvFile("TOKEN=a=b=c")).toEqual({ TOKEN: "a=b=c" })
  })

  it("skips malformed keys and lines without '='", () => {
    expect(parseEnvFile("not-a-pair\n1BAD=x\n=novalue\nGOOD=y")).toEqual({ GOOD: "y" })
  })
})

describe("loadEnv", () => {
  let dir: string
  const originalEnvFile = process.env.UW_ENV_FILE
  const originalValue = process.env.UW_TEST_ENV_VALUE

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uw-env-"))
    delete process.env.UW_TEST_ENV_VALUE
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (originalEnvFile === undefined) delete process.env.UW_ENV_FILE
    else process.env.UW_ENV_FILE = originalEnvFile
    if (originalValue === undefined) delete process.env.UW_TEST_ENV_VALUE
    else process.env.UW_TEST_ENV_VALUE = originalValue
  })

  it("applies values from the file named by UW_ENV_FILE", () => {
    const path = join(dir, "secrets.env")
    writeFileSync(path, "UW_TEST_ENV_VALUE=from-file\n")
    process.env.UW_ENV_FILE = path

    expect(loadEnv()).toBe(path)
    expect(process.env.UW_TEST_ENV_VALUE).toBe("from-file")
  })

  it("never overwrites a variable already set in the environment", () => {
    const path = join(dir, "secrets.env")
    writeFileSync(path, "UW_TEST_ENV_VALUE=from-file\n")
    process.env.UW_ENV_FILE = path
    process.env.UW_TEST_ENV_VALUE = "from-environment"

    loadEnv()
    expect(process.env.UW_TEST_ENV_VALUE).toBe("from-environment")
  })

  it("leaves the environment untouched when the named file is missing", () => {
    process.env.UW_ENV_FILE = join(dir, "missing.env")

    loadEnv()
    expect(process.env.UW_TEST_ENV_VALUE).toBeUndefined()
  })
})
