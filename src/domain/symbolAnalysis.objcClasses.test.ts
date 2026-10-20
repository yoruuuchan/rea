import { describe, expect, it } from "vitest";

import {
  discoverObjcClasses,
  projectObjcClassCandidates,
} from "./symbolAnalysis.js";

const completeCoverage = { status: "complete" as const, reason: null };
const classImport = {
  requested_address: "0x1000",
  symbol: "_OBJC_CLASS_$_Document",
  binding_source: "bind" as const,
  library_ordinal: 1,
  library: "/System/Library/Frameworks/AppKit.framework/AppKit",
  weak: false,
  addend: "0",
};

describe("Objective-C class label discovery", () => {
  it("does not reinterpret a provider-specific label without an owner tag", () => {
    expect(
      discoverObjcClasses(
        [{ address: "0x1", name: "__objc_class_HuntRoot_class" }],
        "Hunt",
      ),
    ).toEqual({
      count: 0,
      classes: [],
      identity_coverage: { status: "not_applicable", reason: null },
    });
  });

  it("uses provider-tagged stripped class labels and filters their exact text", () => {
    const labels = [
      "__objc_class_HuntRoot_class",
      "__objc_class_HuntSub_class",
      "__objc_class_HuntWorker_class",
      "__objc_class_HuntModel_class",
      "__objc_class_HuntLegacy_class",
      "__objc_class_Hunt_class_class",
      "prefix__objc_class_HuntForeign_class",
      "__objc_class__class",
      "__objc_class_HuntMissingSuffix",
      "__objc_class_HuntExtra_class_suffix",
    ];
    const names = labels.map((name, index) => ({
      address: `0x${(index + 1).toString(16)}`,
      name,
      ...(index < 6
        ? { objc_class_label: "hopper_legacy_class_object" as const }
        : {}),
    }));

    expect(discoverObjcClasses(names, "Hunt")).toEqual({
      count: 6,
      classes: names.slice(0, 6).map(({ address, name }) => ({
        address,
        name,
      })),
      identity_coverage: {
        status: "unknown",
        reason: "Exact class-import binding identity is unavailable.",
      },
    });
    expect(discoverObjcClasses(names, "__objc_class_HuntRoot_class")).toEqual({
      count: 1,
      classes: [{ address: "0x1", name: "__objc_class_HuntRoot_class" }],
      identity_coverage: {
        status: "unknown",
        reason: "Exact class-import binding identity is unavailable.",
      },
    });
  });

  it("coalesces only selected rows whose own addresses prove the same import", () => {
    const alias = { address: "0x1000", name: "OBJC_CLASS_$_Document$GOT" };
    const canonical = { address: "0x1000", name: "OBJC_CLASS_$_Document" };
    const unrelated = { address: "0x2000", name: "OBJC_CLASS_$_Document" };
    const scan = {
      bindings: [classImport],
      coverage: completeCoverage,
    };

    expect(
      projectObjcClassCandidates([alias, canonical, unrelated], scan),
    ).toEqual({
      count: 2,
      classes: [
        {
          ...canonical,
          binding_identity: {
            symbol: classImport.symbol,
            binding_source: classImport.binding_source,
            library_ordinal: classImport.library_ordinal,
            library: classImport.library,
            weak: false,
            addend: "0",
            slot_addresses: ["0x1000"],
          },
        },
        unrelated,
      ],
      identity_coverage: completeCoverage,
    });
    expect(discoverObjcClasses([alias, canonical], "$GOT", scan)).toEqual({
      count: 1,
      classes: [
        {
          ...alias,
          binding_identity: {
            symbol: classImport.symbol,
            binding_source: classImport.binding_source,
            library_ordinal: classImport.library_ordinal,
            library: classImport.library,
            weak: false,
            addend: "0",
            slot_addresses: ["0x1000"],
          },
        },
      ],
      identity_coverage: completeCoverage,
    });
  });

  it("does not join same-name rows without exact slot evidence", () => {
    const alias = { address: "0x1000", name: "OBJC_CLASS_$_Document$GOT" };
    const canonical = { address: "0x2000", name: "OBJC_CLASS_$_Document" };
    expect(
      projectObjcClassCandidates([alias, canonical], {
        bindings: [classImport],
        coverage: completeCoverage,
      }),
    ).toMatchObject({ count: 2, classes: [alias, canonical] });
  });

  it("keeps rows separate when equal symbols have different bind identities", () => {
    const rows = [
      { address: "0x1000", name: "OBJC_CLASS_$_Document$GOT" },
      { address: "0x2000", name: "OBJC_CLASS_$_Document$GOT" },
    ];
    expect(
      projectObjcClassCandidates(rows, {
        bindings: [
          classImport,
          {
            ...classImport,
            requested_address: "0x2000",
            library: "/other/framework.dylib",
          },
        ],
        coverage: completeCoverage,
      }),
    ).toMatchObject({ count: 2, classes: rows });
  });

  it("keeps same-named candidates at distinct addresses until bind identity is known", () => {
    const rows = [
      { address: "0x1000", name: "OBJC_CLASS_$_Document" },
      { address: "0x1000", name: "OBJC_CLASS_$_Document" },
      { address: "0x2000", name: "OBJC_CLASS_$_Document" },
    ];
    expect(discoverObjcClasses(rows, "")).toEqual({
      count: 2,
      classes: [rows[0], rows[2]],
      identity_coverage: {
        status: "unknown",
        reason: "Exact class-import binding identity is unavailable.",
      },
    });
  });
});

it("keeps equal symbols separate when only their lookup ordinals differ", () => {
  const rows = [
    { address: "0x1000", name: "OBJC_CLASS_$_Document$GOT" },
    { address: "0x2000", name: "OBJC_CLASS_$_Document$GOT" },
  ];
  expect(
    discoverObjcClasses(rows, "", {
      bindings: [
        { ...classImport, library_ordinal: -1, library: null },
        {
          ...classImport,
          requested_address: "0x2000",
          library_ordinal: -2,
          library: null,
        },
      ],
      coverage: completeCoverage,
    }),
  ).toMatchObject({
    count: 2,
    classes: [
      { ...rows[0], binding_identity: { library_ordinal: -1 } },
      { ...rows[1], binding_identity: { library_ordinal: -2 } },
    ],
  });
});

it("keeps regular self-scope and weak rebinding records separate", () => {
  const rows = [
    { address: "0x1000", name: "OBJC_CLASS_$_Document$GOT" },
    { address: "0x2000", name: "OBJC_CLASS_$_Document$GOT" },
  ];
  expect(
    discoverObjcClasses(rows, "", {
      bindings: [
        { ...classImport, library_ordinal: 0, library: null },
        {
          ...classImport,
          requested_address: "0x2000",
          binding_source: "weak",
          library_ordinal: 0,
          library: null,
        },
      ],
      coverage: completeCoverage,
    }),
  ).toMatchObject({
    count: 2,
    classes: [
      { ...rows[0], binding_identity: { binding_source: "bind" } },
      { ...rows[1], binding_identity: { binding_source: "weak" } },
    ],
  });
});
