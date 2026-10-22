# Environment state view from captures

Issue: https://github.com/morluto/rea/issues/4933

## Outcome

`inspect_analysis_view` accepts `view: {"kind": "environment-state"}` for the
parents the environment manifest accepts and extracts the initial state the
capture's reads observed: entity types with an identity field, entities with
their recorded values, documents for written paths whose reads are not
entities, and a render plan per read tool that reproduces the tool's latest
initial recordings from the state, or a recorded view with the reason it
cannot. This increment adds the view kind only; serving from the state, loading
another state through the AgentEnv data plane and modelling write effects are
later increments.

## Requirements

- Accept `inspect_web_network_capture` HAR parents and
  `capture_browser_scenario` parents that selected response bodies, with the
  manifest's admission: the same format, subject and sensitive-value refusals.
- Group records exactly as the manifest does for the same `template_rules`, so
  tool names match the manifest the state accompanies.
- Order primary-origin records by recorded start time, or by record order when
  any start time is missing, and say which. Bound each type's state by the first
  write under its root (API base, version segments, one segment); a query
  `POST` is not a write, a read overlapping the write is left out, and a write
  whose URL was redacted bounds every type, with a limitation counting it.
- Prove an item type's identity field from the requested path value its
  responses repeat; otherwise infer it from a fixed list of identity names that
  every listed item carries distinctly, which needs at least one listed item.
  An item read that asked for some fields only (`fields`, `fields[...]`,
  `select`, `$select`) and does not return the item is left out of the proof
  and of the view's checks; the view lists it in `projected_record_ordinals`,
  and serving replays any call to that tool that names a projection parameter
  for an entity the state holds. The write gate also leaves out any read that
  names one and leaves out a field its view requires.
- A field every recording of a view carried is required: serving refuses an
  entity lacking it. Once a successful read the write gate checks, naming no
  projection parameter, shows the application leaves the field out of an entity
  the state holds (APIs that omit empty or false members), no view of the type
  requires it.
  Never treat an envelope that is itself an entity as a list.
- Merge observations into one entity per collection and identity: item views'
  latest values win over list views', differing views keep their own values,
  and a value that changed between repeats of one request line with no recorded
  write is volatile and keeps the latest; a change across a write under another
  root, including between two tools of the type, leaves every tool of the type
  recorded. Compare list membership, including empty lists, and field presence before selecting each request line's latest recording; a change across a write also leaves the type recorded. Different query strings remain distinct; omitted fields do not erase their earlier observations on other request lines.
- An item or list view whose recordings always spell a clock field's instant
  otherwise than the entity's stored value (`Z` against `+00:00`, another
  separator or fraction width) names that spelling in `clock_formats`; a field
  it also shows as stored, or spells two ways (counting values at another
  instant), gets none. A stored value the view never recorded, such as one a
  write made, is rendered in that spelling: its wall clock in the view's zone,
  under the view's separator, with its own fraction digits padded with zeros to
  the view's width and none dropped; an epoch spelling is computed from the
  instant.
- A list has `all` membership only when no item-total envelope member (`total`,
  `count` and their compounds, not page counts) differs from the number of
  entities it lists and no `has_more`, `next` or next-page token is set.
- Keep an item or list plan only when it reproduces each request line's latest
  initial recording from the state, comparing JSON values without regard to
  member order; otherwise record the tool with a reason. Parse bodies only when
  JSON-like, UTF-8, at most 256 KiB, exactly representable and free of
  `__proto__` members.
- Mark the Evidence inferred; state unknowns for authorization, response
  semantics and write effects.
- Charge the manifest's admission and grouping, every record line, every body
  as temporary bytes before decoding and parsing, and every kept value, within
  the existing 96 MiB budget.
- Read response bodies through one domain owner shared with replay, and parse
  exact JSON through the owner of the exact-number policy.

## Acceptance and limits

The Grafana-shaped HAR fixture with distinct start times drives domain,
service, MCP, CLI and acceptance coverage: folders merge their detail and list
views under a proved `uid`, the dashboard entity is read from its `/dashboard`
wrapper, and the annotation list after the annotation write has no initial
recording. Synthetic captures cover write bounds, volatile fields, complete
lists with counters, each recorded reason and documents; the scenario fixture
covers record order and the response-body requirement. The view performs no
network activity and serves nothing. Values copied outside entity objects,
derived values and cross-type effects are not tied to the state.

## Deferred issue criteria

Serving tool calls from the state, `data/reset`, `data/add` and `data/get` on
the environment data plane, exporting the state with a bundle, and write
effects are later increments of #4933. So are documents for item-shaped
written paths (one per identity rather than per template) and for paths that
are only deleted; until then their reads stay recorded. This PR must reference rather than
close the issue.
