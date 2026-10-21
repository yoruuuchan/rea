import type {
  StateEntity,
  StateType,
} from "../../domain/analysisView/environmentStateRules.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { jsonParts } from "../../domain/jsonSerialization.js";
import { err, ok, type Result } from "../../domain/result.js";
import { compositeKey } from "../../domain/unicodeCodePointOrder.js";
import { ENVIRONMENT_SERVE_OPERATION } from "./environmentSource.js";
import type { EnvironmentState } from "./environmentState.js";
import {
  parseStateDocument,
  STATE_INTAKE_LIMIT_BYTES,
  type HeldDocument,
  type StateContent,
} from "./environmentStateDocument.js";

/** The UTF-8 bytes a value's JSON takes, counted part by part so it is never one string. */
const jsonBytes = (value: unknown): number => {
  let bytes = 0;
  for (const part of jsonParts(value)) bytes += Buffer.byteLength(part, "utf8");
  return bytes;
};

/** What `data/get` reports: the current state as a `rea-state/v1` document. */
export interface StateSnapshot {
  readonly rea_state: {
    readonly version: 1;
    readonly state_evidence_id: string;
    readonly types: readonly StateType[];
    readonly entities: readonly StateEntity[];
    readonly documents: readonly HeldDocument[];
  };
}

/**
 * The live state one served environment answers from, shared by every MCP
 * session and the data plane. Mutations are synchronous and swap the whole
 * state, so every answer reads one consistent state.
 */
export class EnvironmentStateStore {
  #entities: ReadonlyMap<string, StateEntity> = new Map();
  #collections: ReadonlyMap<string, readonly StateEntity[]> = new Map();
  #typeCollections: ReadonlyMap<string, readonly string[]> = new Map();
  #documents: ReadonlyMap<string, HeldDocument> = new Map();
  #content: StateContent = { entities: [], documents: [] };
  readonly #types: ReadonlyMap<string, StateType>;

  constructor(readonly state: EnvironmentState) {
    this.#types = new Map(
      state.types.map((type) => [type.collection_template, type]),
    );
    this.reset();
  }

  /** Restore the initial state the Evidence holds. */
  reset(): void {
    this.#install(this.state);
  }

  /** Validate a caller-owned document and copy its JSON values before retaining them. */
  replace(document: unknown): Result<void, AnalysisInputError> {
    return this.#replace(document, false);
  }

  /** Validate and retain a JSON document created exclusively by the serving boundary. */
  replaceOwnedDocument(document: unknown): Result<void, AnalysisInputError> {
    return this.#replace(document, true);
  }

  #replace(
    document: unknown,
    owned: boolean,
  ): Result<void, AnalysisInputError> {
    const content = parseStateDocument(this.state, document, owned);
    if (!content.ok) return content;
    // data/get writes members a document may omit, so the state it reports must still be one data/add loads.
    if (jsonBytes(this.#snapshotOf(content.value)) > STATE_INTAKE_LIMIT_BYTES)
      return err(
        new AnalysisInputError(
          ENVIRONMENT_SERVE_OPERATION,
          {
            userMessage: `The state would exceed ${String(STATE_INTAKE_LIMIT_BYTES)} bytes as data/get writes it.`,
          },
          [
            {
              path: [],
              reason: "out_of_range",
              message: `would exceed ${String(STATE_INTAKE_LIMIT_BYTES)} bytes as data/get writes it`,
              maximum: STATE_INTAKE_LIMIT_BYTES,
            },
          ],
        ),
      );
    this.#install(content.value);
    return ok(undefined);
  }

  type(collectionTemplate: string): StateType | undefined {
    return this.#types.get(collectionTemplate);
  }

  entity(
    type: string,
    collection: string,
    id: string,
  ): StateEntity | undefined {
    return this.#entities.get(compositeKey([type, collection, id]));
  }

  /** One collection's entities in state order. */
  inCollection(type: string, collection: string): readonly StateEntity[] {
    return this.#collections.get(compositeKey([type, collection])) ?? [];
  }

  /** The collections holding entities of one type, in state order of their first entity. */
  collectionsOf(type: string): readonly string[] {
    return this.#typeCollections.get(type) ?? [];
  }

  document(tool: string): HeldDocument | undefined {
    return this.#documents.get(tool);
  }

  snapshot(): StateSnapshot {
    return this.#snapshotOf(this.#content);
  }

  #snapshotOf(content: StateContent): StateSnapshot {
    return {
      rea_state: {
        version: 1,
        state_evidence_id: this.state.evidenceId,
        types: this.state.types,
        entities: content.entities,
        documents: content.documents,
      },
    };
  }

  /** Build every index before assigning any, so a reader never sees half a state. */
  #install(content: StateContent): void {
    const entities = new Map<string, StateEntity>();
    const collections = new Map<string, StateEntity[]>();
    const typeCollections = new Map<string, string[]>();
    for (const entity of content.entities) {
      entities.set(
        compositeKey([entity.type, entity.collection, entity.id]),
        entity,
      );
      const key = compositeKey([entity.type, entity.collection]);
      const members = collections.get(key);
      if (members !== undefined) {
        members.push(entity);
        continue;
      }
      collections.set(key, [entity]);
      const named = typeCollections.get(entity.type);
      if (named === undefined)
        typeCollections.set(entity.type, [entity.collection]);
      else named.push(entity.collection);
    }
    this.#entities = entities;
    this.#collections = collections;
    this.#typeCollections = typeCollections;
    this.#documents = new Map(
      content.documents.map((document) => [document.tool, document]),
    );
    this.#content = content;
  }
}
