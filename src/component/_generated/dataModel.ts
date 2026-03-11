/* eslint-disable */
/**
 * Generated data model types for the component.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  DataModelFromSchemaDefinition,
  DocumentByName,
  TableNamesInDataModel,
} from "convex/server";
import type schema from "../schema.js";

/**
 * The data model for this component.
 */
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;

export type Doc<TableName extends TableNamesInDataModel<DataModel>> =
  DocumentByName<DataModel, TableName>;

export type Id<TableName extends TableNamesInDataModel<DataModel>> =
  DocumentByName<DataModel, TableName>["_id"];
