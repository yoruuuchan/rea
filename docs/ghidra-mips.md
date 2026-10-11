# MIPS ELF analysis through Ghidra

This lane extends native ELF analysis; it does not execute MIPS code or rehost
firmware. It advances the generic-MIPS portion of
[#718](https://github.com/morluto/rea/issues/718), not the whole firmware roadmap.
PSP/Allegrex has a [separate static-ELF profile](ghidra-psp.md) tracked in
[#1330](https://github.com/morluto/rea/issues/1330).

## Admission boundary

ELF `EM_MIPS` is retained as the provider-neutral `mips` family. The target also
retains class, byte order, `e_type`, raw `e_flags`, and inspected ABI declarations.
Recognition does not mean every provider or MIPS variant is supported. Existing
PE, managed and Mach-O architecture sets are unchanged.

The Ghidra lane admits ELF32 `ET_EXEC` and `ET_REL`, little or big endian, with
explicit o32 and `EF_MIPS_ARCH_32R2` flags and no machine-specific or ASE
encoding flags. These are header declarations, not proof that every instruction
conforms to that ISA. ELF64, n32/n64, unspecified ABI, MIPS16/microMIPS,
machine-specific variants, shared objects and PSP PRX are not covered by this
lane. Their family may be identified, but provider selection returns the
specific unsupported constraint rather than guessing a compatible profile.

Explicit `EF_MIPS_FP64` and `EF_MIPS_NAN2008` declarations are refused. Their
absence is insufficient: Clang can emit identical `e_flags` for FP32, FP64 and
soft-float targets. Target resolution also reads the 24-byte ABI flags record
identified by `PT_MIPS_ABIFLAGS` and/or `SHT_MIPS_ABIFLAGS`, without relying on
section names or the record being inside the initial 4 KiB header probe.
Program and section declarations must agree; duplicate, conflicting, truncated
or out-of-file records are rejected. Stripped section tables and section-only
records are supported. Extended table numbering is explicitly unsupported.
For carved ELFs whose section table extends beyond the captured file, REA
examines every complete captured section header and records the unavailable
headers as a limitation. A valid program-header ABI record can still establish
the supported declaration. Available section declarations must agree with it;
their duplicate, conflicting or unreadable records remain errors. A missing
program-header record does not make ABI declarations in uncaptured sections
absent or supply a default ABI.
The field layout follows
[`Elf_MIPS_ABIFlags_v0`](https://github.com/bminor/glibc/blob/master/elf/elf.h).

Provider admission requires record version 0, MIPS32r2, 32-bit GPRs, no CPR2,
no ISA extension, ASE or unknown general flags, and one of two floating-point
declarations: 32-bit CPR1 with a double-precision or FPXX ABI, or no CPR1 with
the soft-float ABI. Other combinations, including single-float, FP64 and
unspecified ABIs, are refused. Missing records remain unknown rather than
defaulting to a compatible ABI, and this lane refuses them. Unknown record
values are retained for diagnosis but do not gain provider support. These checks
bind the declared interpretation; the fixtures do not establish full
floating-point behavioral conformance.

MIPS header and ABI record facts are committed in the analysis profile so
interpretation changes invalidate profile-bound snapshots. The support-lane
identity is versioned independently of file identity. Evidence, lifecycle
outputs and saved snapshots preserve the `mips` family. Hopper and IDA adapters
do not implicitly gain MIPS support. Windows Ghidra P0 remains PE x86/x86-64 only.

### Soft-float prototype

Ghidra's MIPS32 compiler specifications model hard-float o32 only: a typed
`float` or `double` parameter is bound to `$f12`/`$f14` and returned in `$f0`.
Soft-float o32 passes those values in integer registers and stack slots, so a
typed prototype (for example from DWARF) would make the decompiler read FPU
registers the code never writes and drop the real dataflow. That applies to
functions, external functions and indirect calls through typed function
pointers alike.

For soft-float targets REA commits
`mips_soft_float_storage: o32-soft-float-prototype-v1` in the analysis profile
and runs `ReaGhidraMipsSoftFloat.java` after auto-analysis. The script encodes
the program's own default o32 prototype, removes its floating-point parameter
and return entries and the rules that consume floating-point storage, and
installs the result as the program-specific `__rea_soft_float` prototype through
a Ghidra specification extension. Deriving it keeps the byte-order-specific
aggregate rules and the hidden struct-return pointer. The script then assigns
that prototype, with dynamic storage, to every non-thunk function and external
function, and to every function-pointer definition, whose declared types use
`float` or `double`. Thunks follow their targets. Types are kept.

The script fails, and writes no report, if the derived prototype still places a
float in an FPU register or any reassigned function does. It records the
function and definition counts last; REA requires that report exactly when the
profile commits the policy and refuses the session otherwise, before serving any
operation. Session Evidence carries the policy and counts as limitations.
Callables without typed float signatures keep Ghidra's default prototype, under
which Ghidra already infers integer-register parameters. Hard-float profiles do
not gain the policy, so their digests are unchanged.

### Relocatable objects

`ET_REL` objects, such as Linux kernel modules (`.ko`), are imported by Ghidra's
ELF loader, which assigns each allocated section an analysis address and applies
the object's REL relocations there. Undefined symbols are placed in Ghidra's
`EXTERNAL` block: a thunk for code, a label for data. These addresses are
analysis coordinates, not the addresses a kernel or linker would choose, and
session Evidence says so. `inspect_native_load_image` reports each relocation
with Ghidra's status; HI16 entries report `PARTIAL` because Ghidra applies them
together with their paired LO16. Relocatable targets commit
`mips_support_lane: elf32-rel-o32-arch32r2-standard-v1`, separate from the
executable lane, whose identity executable targets keep. Kernel modules are
usually soft-float and therefore also use the soft-float storage policy.

## Use

With a caller-installed Ghidra and compatible JDK on a supported Linux/macOS host:

```bash
rea analyze /absolute/path/to/mips.elf --provider ghidra --json
rea function /absolute/path/to/mips.elf function_name --provider ghidra --json
```

MCP uses the existing tools, including `open_binary` with an absolute path and
`provider_id: "ghidra"`. No MIPS-specific tool catalog or emulator is introduced.
Inspect instructions, caller relationships and data alongside pseudocode. In
particular, delay-slot semantics are supplied by Ghidra, not reconstructed by
REA's ELF parser.

## Verification

### Executables

The source-owned freestanding fixture is `tests/conformance/c/mips.c`; the
soft-float variant also links `tests/conformance/c/mips-soft-float.c`. The
optional cross-target lane requires a caller-supplied Clang with MIPS targets,
LLD, GNU `readelf`, Ghidra and its compatible JDK; ordinary host-native checks
do not acquire these tools. `REA_MIPS_CLANG` selects Clang and
`REA_MIPS_READELF` selects GNU readelf (for example `greadelf` on macOS).
These are test-time prerequisites, not REA runtime providers.

```bash
GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra npm run verify:ghidra:mips
```

The lane compiles both byte orders with hard-float and soft-float ABIs and never
executes the targets. GNU readelf
independently supplies header/ABI facts and symbol addresses, compared with the
production REA target resolver before provider startup. Its version, bounded
command output and selected tool path are retained in the verification report.
The parser deliberately recognizes only this fixture's GNU output, rejecting
missing, ambiguous or unexpected fields rather than substituting defaults.

Existing public MCP operations check Ghidra's **observed** language/compiler
specification and loaded-file hashes. The source-owned `mips-probe.S` supplies
fixed ADDIU and conditional-branch encodings: verification checks bytes, length,
immediate and direct destination, independent of decompiler variable names.
Global and string bytes are checked at independently reported symbol addresses.
ELF load-image results retain observations even though REA's independent
load-image comparison currently covers DOS, not ELF; this lane checks those
observations and does not relabel the upstream result as verified.

CLI/MCP discovery and decompilation, direct calls, target/profile/Evidence
identity, snapshot round-trip and final process cleanup remain covered.
For both byte orders, the lane also carves away the section table while retaining
all program-header payloads. It checks the actual Ghidra language, entry-address
decompilation, distinct artifact digest and missing-section limitations through
CLI Evidence and an MCP-produced snapshot. Caller-selected Ghidra heap limits
are passed to these child workflows.
For soft-float fixtures the lane also checks, through `inspect_native_api`, the
exact parameter and return types and storage of float, double, mixed (pair
alignment and stack spill) and struct-returning functions; that a caller's
decompilation receives every source float constant without FPU inputs,
including an indirect call through a typed function pointer; and that the
snapshot profile and Evidence retain the policy and outcome counts.
Pseudocode presence is a liveness check, not proof of semantic equivalence.
Instruction decoding and reader agreement likewise do not establish runtime,
delay-slot execution or complete floating-point semantics. Assertion regressions
reject incorrect byte order, constants, destinations and loaded identities.
Parser/profile tests are narrower checks, not substitutes for this real-provider
run. Report the actual lanes run and leave unexecuted verification pending.

### Relocatable objects

This lane has its own command and fixture:

```bash
GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra npm run verify:ghidra:mips-relocatable
```

It compiles `tests/conformance/c/mips-relocatable.c` with `-c -G0` in both byte
orders, plus a little-endian soft-float `-mlong-calls` variant matching Linux
module options. GNU readelf independently supplies sections, symbols and REL
entries. For every relocation in an allocated section, the lane reads the
loaded word through `read_bytes` and requires it to encode `S + A`: `S` from
Ghidra's own section placement (`list_segments`) or `EXTERNAL` placement, `A`
from the original file bytes. HI16/LO16 are checked as the effective address
each LO16 forms with each HI16 it resolves, including several HI16s before one
LO16, so a missing signed-low carry fails and a HI16 without a following LO16
fails. The lane also requires matching Ghidra relocation entries and statuses,
section file offsets and sizes, coverage of a shared HI16, a LO16 carry,
external code and data and `R_MIPS_32` words, direct calls from the entry
function, the relocatable support lane in the snapshot profile, the
relocatable limitation in Evidence and an unchanged source object. The fixture
also calls `powf`, an external whose float prototype comes from Ghidra's C
library archive; every variant must decompile `powf(1.5,2.5)` without FPU
inputs, and the soft-float variant must report that the soft-float prototype
covered it.
