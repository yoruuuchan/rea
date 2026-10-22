# Apply write effects to the served state

Issue: https://github.com/morluto/rea/issues/4933

## Outcome

An environment served from its state also serves the write tools whose effects
the capture itself confirms:

- a create adds an entity;
- an update changes the fields the call sends;
- a delete removes the entity;
- a document write changes a document.

Later reads, list membership and `data/get` show the change, and `data/reset`
undoes it.

The `environment-state` view decides which write tools are served. It replays
the capture's own timeline on the extracted initial state: each recorded write
applies its modelled effect, and each later read that the state answers is
rendered and compared with the recorded response. A write tool is served only
when at least one later read reproduces after its effect and none contradicts
it. Every other write tool stays unserved, listed with the reason.

Values the application generates are deterministic: identities, sequences and
clock values follow the formats the capture recorded, so the same calls after
a reset give the same state.

## Write plans

The view adds two members to its result:

- `writes`: one plan per manifest tool whose method may change state
  (`changesState`);
- `write_clock`: the instant the served clock starts from.

**Effects.** Each plan classifies its tool:

| Effect     | Tool                                                                  | Target                    |
| ---------- | --------------------------------------------------------------------- | ------------------------- |
| `create`   | `POST` to a state type's `collection_template`                        | an entity of that type    |
| `update`   | `PUT`, `PATCH` or `POST` to that template plus one trailing parameter | the entity the path names |
| `delete`   | `DELETE` to that same item template                                   | the entity the path names |
| `document` | `PUT`, `PATCH` or `POST` to a document view's path                    | that document             |
| `none`     | anything else                                                         | reason `no-state-target`  |

**Exemplar.** A plan is built from its first successful (2xx) recorded call,
the exemplar.

- **Request body.** The exemplar's request body must be a JSON object that
  could enter the state: a JSON-like media type, complete UTF-8 text within
  256 KiB, exact numbers, no `__proto__` member. Otherwise the reason is
  `body-unusable`. A `DELETE` takes no body.
- **The written entity.** The entity is observed in the exemplar's response,
  located by its identity value at the root, in one member, or in a
  one-element array, as item views locate it. When the response does not carry
  it, the entity is observed in the first later read that shows it: an item
  read of that entity, or for a create, the one entity a collection read newly
  lists. A create whose response names its id alone (a scalar, the identity
  field, or one member) is observed only through a read of that id. With
  neither, the reason is `no-observation`.

**Field rules for creates.** Each field of the observed entity gets the first
rule that explains its value. Rules that read the call come first, so an
identity the client sends is an echo:

1. **Echo.** A body member of the same name with an equal value.
2. **Copy.** A body string of 8 or more characters, found at a JSON pointer of
   the body (the shallowest match).
3. **Path.** The value of a path parameter of the call, percent-decoded.
   Serving decodes it from the collection the call names, whichever spelling
   the call uses, and the gate fills a recorded call's path fields from that
   collection too.
4. **Slug.** The slug of a body string member: lower case, runs of other
   characters joined by `-`.
5. **Identity.** The type's `id_field` is generated. A sequence when it is an
   integer (or a string of digits); otherwise a UUID when it has the
   `8-4-4-4-12` hex shape; otherwise a token of the same length and character
   classes.
6. **Clock.** A timestamp within 10 minutes of the exemplar's start time. The
   format is kept: ISO-8601 with its separator, fraction digits and zone, or
   epoch seconds or milliseconds.
7. **Sequence.** An integer one greater than the largest value of the field in
   the collection, else in the type.
8. **Unique.** A UUID-shaped string that no other entity of the type shares.
9. **Template.** A string containing a generated value as a delimited token
   (for example a URL that ends in the new id). It is rebuilt around the new
   value.
10. **Constant.** Otherwise the exemplar's value.

When a constant, or the text a template keeps, contains a path value of the
exemplar's call as a delimited token, the create is served only for calls
naming the exemplar's collection.

**Body members of a create.** A member is either accepted or not:

- **Accepted.** An echoed member, or the identity field's value. Every member
  the exemplar sent is required.
- **Not accepted.** A member the application stored with a different value
  (transformed), or one it did not show. A call that sends such a member is a
  tool error naming the accepted members.

**Updates.** Body members follow the same accepted and not-accepted rules,
except that a member the application stored differently is accepted only with
the value a recorded call sent it with, and then stores the value that call
recorded (its `constant` rule carries it). The type's identity field never
takes a rule: sent as the path's id it is the identity member, sent as another
value the application ignored it is accepted with that value and stores
nothing, and a stored id that changed is `unexplained-change`. A plan whose
calls use a member both as the identity and as a fixed member, or fix it at
different values, is `unexplained-change`, as serving could not take every
recorded call. So is an update a later read shows dropped a field the
entity held, since serving keeps every field an update does not write; a write's
own response may leave fields out. A member a later call is the first to store,
which the plan's observation does not show, keeps the JSON type that call stored
it as (the body's `kinds`), as an exemplar's member keeps the observation's.
`PUT` requires every member the exemplar sent; `PATCH` and `POST` require at
least one. A field the exemplar's update changed without sending it is
explained as one of:

- clock;
- an increment by one;
- a slug of an echoed member.

A field the entity lacked before is a change too when the view that observed
the update had shown the entity, so a field the application fills in on update
follows its rule. Any other change is `unexplained-change`. An increment or a slug applies to
every call that could take it, so the plan is also `unexplained-change` when
such a rule would give a call of the tool another value than the one it
recorded, or when a later call treats a member otherwise than the plan: one
call echoes it and another stores something else, or the two rule it
differently.

**Deletes.** A delete removes the entity. Its response is the exemplar's
response, with the entity re-rendered when the response carries it.

**Documents.** A document write merges the body's members (replaces them, for
`PUT`) into the document object that holds most of them: the root or one
member. Later calls write at the exemplar's object. Document reads answer only on their recorded line, so a write is
served only at the path the state holds the document at, and the gate treats a
recorded write at another path as an unmodelled write. A recorded write whose
body serving would refuse (a member of another JSON type than the document
holds) is `unexplained-change`.

**Responses.** A write answers with the status and content type of one
recorded response:

| Response   | Body                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `entity`   | the written entity, rendered into the recorded envelope at the plan's pointer through the recorded fields |
| `identity` | the recorded body with the new identity at the plan's pointer                                             |
| `empty`    | no body                                                                                                   |
| `recorded` | the recorded body                                                                                         |

A rendered body missing a field the recorded response carried is a tool error,
and the state is left unchanged.

**List position.** A create's `insert` rule places the new entity in its
collection's order: sorted by the identity field or a clock field (ascending
or descending), `first` or `last`. The rule is the first candidate consistent
with both the initial `all`-membership recordings and the position a later
recorded list shows. With no evidence, the rule is `last`.

## The gate

The view replays every primary-origin record in timeline order on a copy of
the initial state.

**Writes.** Only a 2xx write is modelled. A modelled write applies its effect, using the values it recorded
for generated fields and the stored values for fields it transformed. A
modelled write whose call the plan does not explain brings its entity to the
recorded outcome instead, without attribution. So does an update of an unknown
entity (below): its call cannot be checked, so it adds nothing to a built plan.
A later create whose generated
values take another form than serving gives them (a sequence value out of
order, a clock in another format, a non-UUID unique value) makes the plan
`unexplained-change`; integer identities are left to the id mapping. An update or
delete names its entity as an item read does (below). A later update that does
not answer with its entity is observed only by a read whose view shows every
clock the plan learned, since serving stamps them; without one it is unmodelled.

Any other write that may have changed state, including a redirected or
unanswered one, is unmodelled, and what it may have changed
depends on where its path lies relative to each type's collection paths
(segment-prefix related, parameters matching any segment):

- **Below an item path:** the named entity is unknown until a read shows it
  again. When the path names no held entity, every entity of that collection
  is unknown.
- **At a collection path:** that collection is not checked again.
- **Above collection paths:** everything under the path is not checked again.

The path names its entity as an update's does and its collection as a create's
does, so a plain spelling reaches a collection held under an encoded one; a
path above collections covers each collection whose segments are its own
verbatim or once percent-decoded.

An item read of an unknown entity shows it again: the copy takes its recorded
values. A failed read that is no absence shows nothing, and the entity stays
unknown. Writes that changed it since its last check are checked only on the
members they sent, less those the view treats as volatile, which show nothing
of a write.

**Reads.** A read is checked when the served environment would answer it
from the state:

- an item read of a state-backed item view, of the entity serving would name:
  in a held collection the read's path matches, each segment verbatim or once
  percent-decoded and verbatim spellings first, the id percent-decoded once,
  then as written;
- a list or document read on one of its view's checked request lines,
  chosen as replay chooses the line for the read's call: each path parameter
  the read's value verbatim or once percent-decoded, preferring verbatim
  spellings, then recorded order, and the query values decoded, in any order.
  A read with no query on a whole list falls back, as serving does, on a
  checked line that only pages it. A line whose query repeats a name with
  different values is never chosen, since no call's arguments can name it; one
  repeating a name with one value is, as a call naming it matches both. A list
  is compared as served from the collection of that line. A read on a page
  (`limit`, `size`, `per_page` and the like, or a `_start`–`_end` range; a size
  of zero is no bound on a line whose recording listed items under it, while its
  other sizes and range still bound the page) of a
  whole list checks nothing once the collection holds more entities than the
  page, which serving then answers from its recording.
- A read made while a modelled write to its entity or collection was still
  running, starting before that write ended, checks nothing: it may show the
  state before or after the write. Nor does such a read show an unknown entity
  again.
- A read a write's effect was learned from checks nothing of that write, but
  still contradicts the other writes it exercises.

**Comparison.** The read's answer is the full response serving would give from
the copy: an item read's entity rendered into its item view's base recording,
or a list read's members as serving would list them (so a member the copy no
longer holds fails the check) rendered into its line's base recording. It is
compared with the recording, as the read gate compares, with volatile fields taking the
observed values. A recorded 400, 404 or 410, or a 2xx with a JSON `null`
body, for an entity the copy does not hold agrees with it. A successful read
whose usable body no longer holds the entity or the list fails, as does one of
an entity lacking a field every recording of its view carried, which serving
refuses to answer with.

**Attribution.**

- A check exercises the write tools that changed its entity or collection
  since the previous check of it, less those whose effect later writes erased.
  An update's effect is the fields it sent or changed, derived ones included.
  A later update overwrites the fields it sets (an increment adds to its field
  instead), a recorded outcome every field, and a create or delete the whole
  entity. A document write's effect is the members it merged at its
  object, or everything under the object it replaces, the whole document at the
  root; an entity's fields match by name only, whatever their names look like. A write with nothing left on an entity no
  longer counts there, nor in a collection where no entity it changed keeps any
  of its effect. A mismatch contradicts them. A pass confirms those it shows
  something of: a create's or delete's membership, or a changed field the
  read's view shows and does not treat as volatile; a read that shows none of
  an update's changes confirms nothing of it, and leaves it for a later check
  of that entity or collection.
- A mismatch contradicts each exercised write that no unmodelled write came
  after its latest call on any of the read's entities or collections where its
  effect survives, whatever earlier write is still pending. For a failed list read the unmodelled write must
  also follow the last check and pending writes of each member that differs, so an older change elsewhere
  does not excuse a newer write the list shows undone. An item read checks the writes an unmodelled
  write did follow only on the members they sent, and a list with such a write
  is not checked again: the unmodelled write may explain the rest.
- A mismatch on an entity or collection that no write changed contradicts,
  as `side-effect`, the modelled writes since that previous check whose paths
  are segment-prefix related to the read's path.
- After a failed item check, the copy takes the read's recorded values (or
  drops the entity on a recorded absence). A list whose check failed is not
  checked again.
- A list that fails only for where one create placed its entity passes when
  another of that create's insert candidates reproduces it, which then
  becomes the plan's rule, unless an earlier list check relied on the rule
  (an item read's confirmation does not fix it).
- The read that supplied a create's or update's observation does not check
  it, but checks the other writes it exercises.

**Verdicts.** A plan is served when at least one check confirms it and none
contradicts it. Otherwise the reason, in this precedence, is:

1. the first build reason;
2. `contradicted`, with `contradicted_by` naming the first contradicting read;
3. `side-effect`;
4. `unconfirmed`;
5. `incomplete-entities`: an update or delete that answers with the entity,
   when no initial entity holds every field its recorded answer shows (for
   example a delete that answers with an edit view of the entity the reads
   never showed), so it could answer only for entities the environment itself
   created. An update's answer renders the entity it wrote, so a field one of
   its rules writes counts as held, except an increment's, which adds only to
   a held value.

`checked_record_ordinals` lists the confirming reads.

## Serving

**Catalog.** In state mode, the catalog adds the write tools whose plan is
served. Their descriptions say the tool:

- applies its effect to the served state;
- names its target type;
- lists its required and accepted body members, quoted and sampled within the
  description budget as response fields are.

The discovery budget charges them. `--replay-only` and the replay fallback are
unchanged.

**Calls.** A served write answers synchronously against the live store and
changes it atomically, so every MCP session and `data/get` see one state.

**Refusals.** These are tool errors that leave the state unchanged:

- a body that is not an object;
- a missing required member;
- a member that is not accepted;
- a value of another JSON type than the exemplar's (for a member only a later
  update stored, that call's), for documents as well as entities;
- an update or delete of an entity the state does not hold;
- a create in another collection when the plan is tied to its own;
- a document write at a path other than the one the state holds it at;
- a body member or a resulting value `data/add` would refuse (a number not
  exact as `data/get` writes it, a `__proto__` member, nesting past the
  limit), increments included, so `data/get` always loads back;
- a create, update or document write that would take what `data/get` reports
  past the 32 MiB `data/add` intake limit, as a `resource_constraint` error;
- a rendered response missing a recorded field.

When the tool, or else an item view of the type, recorded a 400, 404 or 410
response, an update or delete of a missing entity answers with the latest such
recording instead.

A create in a collection held under more than one spelling (`acme1` and
`%61cme1`) goes to the one the call spells verbatim, as item calls choose their
entity; a collection keeps its spelling after its last entity is deleted. A
reset or load knows the spellings of the Evidence's state, of the state it
installs and of the type's checked list lines (so a collection the capture
listed empty keeps its spelling), never those of a state it replaced. When two
spellings fit a call equally, the one holding entities wins. `data/add` refuses a document that `data/get` would write back past the
32 MiB intake limit once it adds the members a document may omit, such as
`types` and the state Evidence id. A derived state `data/get` would write
past that limit is not served: the environment serves replay and reports the
state `unavailable`.

**Clock and generators.** The store's clock starts at `write_clock` and
advances one second before each served write; clock fields take its value in
their recorded format.

- **Sequences:** one more than the largest current value in their scope, the
  largest the state started with at its last reset or load, and the largest
  value they generated, so a deleted entity's value is not reused, as database
  sequences do not reuse values.
- **UUIDs and tokens:** derived from a SHA-256 of the state Evidence id, the
  tool, the field and a write counter, skipping values the type already holds.

`data/reset` and `data/add` restart the clock, the counter and the
sequences.

**Missing entities.** An item read of an entity the state does not hold
answers with the tool's latest recorded 400, 404 or 410 response, or 2xx JSON
`null` response, the absences the gate accepts, when it has one, labelled
`state.view: "missing"`. Otherwise it stays a tool error.

**Lists of a whole collection.** Written entities matter only if lists show
them, so the read gate's `membership: "all"` also covers a line that only pages
its list (`limit`, `offset`, `page`, `per_page`, `perpage`, `page_size`,
`pagesize`, `size`, `start`, `_start`, `_end`) when its recording listed the
whole collection. A list call with no query argument answers from such a line
of an `all` view of the collection its path arguments name, with
`replay.exact_match` false; a collection with no such line answers from its
recording. A call that asks for a page
still answers from its recording.

**Provenance.** Write answers carry `state: {source: "state", view: "create" |
"update" | "delete", type, collection, id}`, or `{source: "state", view:
"document-write", path}`.

**Data plane and export.**

- `data/get` reports written entities without record citations; they load
  back through `data/add` unchanged.
- `environment-export` counts served write tools in the bundle's tool count
  and README. Its check stays a read tool.

## Not modelled

These stay unserved, or are labelled in the description:

- side effects on counters, relations and copies of entities in other
  collections;
- inputs the application transforms;
- members the capture never sent;
- reordering after an update;
- membership of filtered or paged lists, which answer their recorded members;
- write paths the manifest left literal;
- writes whose request body the capture did not retain;
- referential rules on delete: a delete removes the entity alone, so an
  application that refuses to delete a referenced entity, or deletes its
  dependents with it, is not modelled;
- authorization.

## Acceptance

- **Domain tests:** classification, every field rule, request-body admission,
  observation from a later read, the insert rules, every verdict and reason,
  attribution and resynchronisation, and taint by an unmodelled write.
- **Services tests:**
  - store mutations and their atomicity;
  - every refusal;
  - generated values and their determinism across reset;
  - `data/get` round trips of written entities;
  - the recorded 404 for missing entities;
  - the catalog and descriptions in each mode.
- **Boundary test:** a write tool changes the next read over MCP.

**Real captures.**

- The view runs over every showcase capture within its budget, and the
  verification reports, per capture, the write tools served and the reasons
  for the rest.
- One environment, chosen at random among those serving a write tool, is
  exported, run in the AgentEnv framework, and graded from `data/get` after an
  agent's create, update and delete.
- The served model is compared with that application running live on the same
  calls.

No test reaches an external network.
