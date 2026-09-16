class TestOutputParser {
  static clean(value) {
    return String(value || "")
      .replace(/[\u001b\u009b]\[[0-?]*[ -\/]*[@-~]/g, "")
      .replace(/[\u001b]\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
  }

  static summarize(output, status) {
    const text = this.clean(output);
    const passed =
      [...text.matchAll(/(?:pass(?:ed|ing)?|tests? passed)\D+(\d+)/gi)]
        .map((match) => Number(match[1]))
        .find(Number.isFinite) ?? null;
    const failed =
      [...text.matchAll(/(?:fail(?:ed|ures?)?|tests? failed)\D+(\d+)/gi)]
        .map((match) => Number(match[1]))
        .find(Number.isFinite) ?? (status === "FAILED" ? 1 : null);
    const skipped =
      [...text.matchAll(/(?:skip(?:ped)?|pending)\D+(\d+)/gi)]
        .map((match) => Number(match[1]))
        .find(Number.isFinite) ?? null;
    const failures = [];
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:FAIL|not ok)\s+(.+)$/i);
      if (match)
        failures.push({
          test: match[1].trim(),
          file: null,
          line: null,
          column: null,
          message: null,
        });
    }
    return {
      summary: {
        total: [passed, failed, skipped].every(Number.isFinite)
          ? passed + failed + skipped
          : null,
        passed,
        failed,
        skipped,
      },
      failures,
    };
  }

  static headTail(text, maxCharacters) {
    const value = this.clean(text);
    const limit = Math.max(100, Number(maxCharacters) || 12000);
    if (value.length <= limit)
      return { text: value, head: value, tail: value, truncated: false };
    const headLength = Math.floor(limit * 0.4);
    const tailLength = limit - headLength;
    const head = value.slice(0, headLength);
    const tail = value.slice(-tailLength);
    return {
      text: `${head}\n...[output truncated]...\n${tail}`,
      head,
      tail,
      truncated: true,
    };
  }
}

window.TestOutputParser = TestOutputParser;
