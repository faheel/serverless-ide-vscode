import { JSONSchema } from "./../../jsonSchema";
import {
  JSONWorkerContribution,
  CompletionsCollector
} from "./../../jsonContributions";
import { ASTNode, PropertyASTNode } from "./../../parser/jsonParser";
import { ResolvedSchema } from "../jsonSchemaService";
import { SingleYAMLDocument } from "../../parser/yamlParser";
import {
  CompletionItemKind,
  TextDocument,
  InsertTextFormat
} from "vscode-languageserver-types";
import * as textCompletions from "./text";
import * as helpers from "./helpers";
import * as nls from "vscode-nls";
import { getResourcesCompletions } from "./resources";
import { logObject } from "../../utils/objects";
import { getDefaultPropertyCompletions } from "./defaultPropertyCompletions";

const localize = nls.loadMessageBundle();

export const getPropertyCompletions = (
  schema: ResolvedSchema,
  doc: SingleYAMLDocument,
  node: ASTNode,
  addValue: boolean,
  collector: CompletionsCollector,
  separatorAfter: string
): void => {
  let matchingSchemas = doc.getMatchingSchemas(schema.schema);
  matchingSchemas.forEach(s => {
    if (s.node === node && !s.inverted) {
      let schemaProperties = s.schema.properties;
      if (schemaProperties) {
        Object.keys(schemaProperties).forEach((key: string) => {
          let propertySchema = schemaProperties[key];
          if (
            !propertySchema.deprecationMessage &&
            !propertySchema["doNotSuggest"]
          ) {
            collector.add({
              kind: CompletionItemKind.Property,
              label: key,
              insertText: textCompletions.getInsertTextForProperty(
                key,
                propertySchema,
                addValue,
                separatorAfter
              ),
              insertTextFormat: InsertTextFormat.Snippet,
              documentation: propertySchema.description || ""
            });
          }
        });
      }
      // Error fix
      // If this is a array of string/boolean/number
      //  test:
      //    - item1
      // it will treated as a property key since `:` has been appended
      if (
        node.type === "object" &&
        node.parent &&
        node.parent.type === "array" &&
        s.schema.type !== "object"
      ) {
        addSchemaValueCompletions(s.schema, collector, separatorAfter);
      }
    }
  });
};

export const getValueCompletions = (
  schema: ResolvedSchema,
  doc: SingleYAMLDocument,
  node: ASTNode,
  offset: number,
  document: TextDocument,
  collector: CompletionsCollector
): void => {
  let offsetForSeparator = offset;
  let parentKey: string = null;
  let valueNode: ASTNode = null;

  getDefaultPropertyCompletions(node, collector);

  if (
    node &&
    (node.type === "string" ||
      node.type === "number" ||
      node.type === "boolean")
  ) {
    offsetForSeparator = node.end;
    valueNode = node;
    node = node.parent;
  }

  if (node && node.type === "null") {
    let nodeParent = node.parent;

    /*
     * This is going to be an object for some reason and we need to find the property
     * Its an issue with the null node
     */
    if (nodeParent && nodeParent.type === "object") {
      for (let prop in nodeParent["properties"]) {
        let currNode = nodeParent["properties"][prop];
        if (currNode.key && currNode.key.location === node.location) {
          node = currNode;
        }
      }
    }
  }

  if (!node) {
    addSchemaValueCompletions(schema.schema, collector, "");
    return;
  }

  if (
    node.type === "property" &&
    offset > (<PropertyASTNode>node).colonOffset
  ) {
    let propertyNode = <PropertyASTNode>node;
    let valueNode = propertyNode.value;
    if (valueNode && offset > valueNode.end) {
      return; // we are past the value node
    }
    parentKey = propertyNode.key.value;
    node = node.parent;
  }

  let separatorAfter = helpers.evaluateSeparatorAfter(
    document,
    offsetForSeparator
  );
  if (node && (parentKey !== null || node.type === "array")) {
    let matchingSchemas = doc.getMatchingSchemas(schema.schema);

    matchingSchemas.forEach(s => {
      if (s.node === node && !s.inverted && s.schema) {
        if (s.schema.items) {
          if (Array.isArray(s.schema.items)) {
            let index = helpers.findItemAtOffset(node, document, offset);
            if (index < s.schema.items.length) {
              addSchemaValueCompletions(
                s.schema.items[index],
                collector,
                separatorAfter,
                true
              );
            }
          } else if (s.schema.items.type === "object") {
            collector.add({
              kind: helpers.getSuggestionKind(s.schema.items.type),
              label: `- (array item)`,
              documentation: `Create an item of an array${
                s.schema.description === undefined
                  ? ""
                  : "(" + s.schema.description + ")"
              }`,
              insertText: `- ${textCompletions
                .getInsertTextForObject(s.schema.items, separatorAfter)
                .insertText.trimLeft()}`,
              insertTextFormat: InsertTextFormat.Snippet
            });
          } else {
            addSchemaValueCompletions(
              s.schema.items,
              collector,
              separatorAfter,
              true
            );
          }
        }
        if (s.schema.properties) {
          let propertySchema = s.schema.properties[parentKey];
          if (propertySchema) {
            addSchemaValueCompletions(
              propertySchema,
              collector,
              separatorAfter,
              false
            );
          }
        }
      }
    });
  }

  if (node.type === "object") {
    const parent = node.parent as PropertyASTNode;

    if (parent && parent.key.value === "Resources") {
      getResourcesCompletions(schema, doc, offset, separatorAfter, collector);
    }
  }
};

export const getContributedValueCompletions = (
  contributions: JSONWorkerContribution[],
  node: ASTNode,
  offset: number,
  document: TextDocument,
  collector: CompletionsCollector,
  collectionPromises: Thenable<any>[]
) => {
  if (!node) {
    contributions.forEach(contribution => {
      let collectPromise = contribution.collectDefaultCompletions(
        document.uri,
        collector
      );
      if (collectPromise) {
        collectionPromises.push(collectPromise);
      }
    });
  } else {
    if (
      node.type === "string" ||
      node.type === "number" ||
      node.type === "boolean" ||
      node.type === "null"
    ) {
      node = node.parent;
    }
    if (
      node.type === "property" &&
      offset > (<PropertyASTNode>node).colonOffset
    ) {
      let parentKey = (<PropertyASTNode>node).key.value;

      let valueNode = (<PropertyASTNode>node).value;
      if (!valueNode || offset <= valueNode.end) {
        let location = node.parent.getPath();
        contributions.forEach(contribution => {
          let collectPromise = contribution.collectValueCompletions(
            document.uri,
            location,
            parentKey,
            collector
          );
          if (collectPromise) {
            collectionPromises.push(collectPromise);
          }
        });
      }
    }
  }
};

export const getCustomTagValueCompletions = (
  collector: CompletionsCollector,
  customTags: Array<String>
) => {
  customTags.forEach(customTagItem => {
    let tagItemSplit = customTagItem.split(" ");
    if (tagItemSplit && tagItemSplit[0]) {
      addCustomTagValueCompletion(collector, " ", tagItemSplit[0]);
    }
  });
};

export const addSchemaValueCompletions = (
  schema: JSONSchema,
  collector: CompletionsCollector,
  separatorAfter: string,
  forArrayItem = false
): void => {
  let types: { [type: string]: boolean } = {};
  addSchemaValueCompletionsCore(
    schema,
    collector,
    types,
    separatorAfter,
    forArrayItem
  );

  if (types["boolean"]) {
    addBooleanValueCompletion(true, collector, separatorAfter);
    addBooleanValueCompletion(false, collector, separatorAfter);
  }
  if (types["null"]) {
    addNullValueCompletion(collector, separatorAfter);
  }
};

export const addSchemaValueCompletionsCore = (
  schema: JSONSchema,
  collector: CompletionsCollector,
  types: { [type: string]: boolean },
  separatorAfter: string,
  forArrayItem = false
): void => {
  addDefaultValueCompletions(
    schema,
    collector,
    separatorAfter,
    0,
    forArrayItem
  );
  addEnumValueCompletions(schema, collector, separatorAfter, forArrayItem);
  collectTypes(schema, types);
  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach(s =>
      addSchemaValueCompletionsCore(
        s,
        collector,
        types,
        separatorAfter,
        forArrayItem
      )
    );
  }
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach(s =>
      addSchemaValueCompletionsCore(
        s,
        collector,
        types,
        separatorAfter,
        forArrayItem
      )
    );
  }
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach(s =>
      addSchemaValueCompletionsCore(
        s,
        collector,
        types,
        separatorAfter,
        forArrayItem
      )
    );
  }
};

export const addDefaultValueCompletions = (
  schema: JSONSchema,
  collector: CompletionsCollector,
  separatorAfter: string,
  arrayDepth = 0,
  forArrayItem = false
): void => {
  let hasProposals = false;
  if (schema.default) {
    let type = schema.type;
    let value = schema.default;
    for (let i = arrayDepth; i > 0; i--) {
      value = [value];
      type = "array";
    }
    collector.add({
      kind: helpers.getSuggestionKind(type),
      label: forArrayItem
        ? `- ${helpers.getLabelForValue(value)}`
        : helpers.getLabelForValue(value),
      insertText: forArrayItem
        ? `- ${textCompletions.getInsertTextForValue(value, separatorAfter)}`
        : textCompletions.getInsertTextForValue(value, separatorAfter),
      insertTextFormat: InsertTextFormat.Snippet,
      detail: localize("json.suggest.default", "Default value")
    });
    hasProposals = true;
  }
  if (!hasProposals && schema.items && !Array.isArray(schema.items)) {
    addDefaultValueCompletions(
      schema.items,
      collector,
      separatorAfter,
      arrayDepth + 1
    );
  }
};

export const addEnumValueCompletions = (
  schema: JSONSchema,
  collector: CompletionsCollector,
  separatorAfter: string,
  forArrayItem = false
): void => {
  if (Array.isArray(schema.enum)) {
    for (let i = 0, length = schema.enum.length; i < length; i++) {
      let enm = schema.enum[i];
      let documentation = schema.description;
      if (schema.enumDescriptions && i < schema.enumDescriptions.length) {
        documentation = schema.enumDescriptions[i];
      }
      collector.add({
        kind: helpers.getSuggestionKind(schema.type),
        label: forArrayItem
          ? `- ${helpers.getLabelForValue(enm)}`
          : helpers.getLabelForValue(enm),
        insertText: forArrayItem
          ? `- ${textCompletions.getInsertTextForValue(enm, separatorAfter)}`
          : textCompletions.getInsertTextForValue(enm, separatorAfter),
        insertTextFormat: InsertTextFormat.Snippet,
        documentation
      });
    }
  }
};

export const collectTypes = (
  schema: JSONSchema,
  types: { [type: string]: boolean }
) => {
  let type = schema.type;
  if (Array.isArray(type)) {
    type.forEach(t => (types[t] = true));
  } else {
    types[type] = true;
  }
};

export const addBooleanValueCompletion = (
  value: boolean,
  collector: CompletionsCollector,
  separatorAfter: string
): void => {
  collector.add({
    kind: helpers.getSuggestionKind("boolean"),
    label: value ? "true" : "false",
    insertText: textCompletions.getInsertTextForValue(value, separatorAfter),
    insertTextFormat: InsertTextFormat.Snippet,
    documentation: ""
  });
};

export const addNullValueCompletion = (
  collector: CompletionsCollector,
  separatorAfter: string
): void => {
  collector.add({
    kind: helpers.getSuggestionKind("null"),
    label: "null",
    insertText: "null" + separatorAfter,
    insertTextFormat: InsertTextFormat.Snippet,
    documentation: ""
  });
};

export const addCustomTagValueCompletion = (
  collector: CompletionsCollector,
  separatorAfter: string,
  label: string
): void => {
  collector.add({
    kind: helpers.getSuggestionKind("string"),
    label: label,
    insertText: label + separatorAfter,
    insertTextFormat: InsertTextFormat.Snippet,
    documentation: ""
  });
};