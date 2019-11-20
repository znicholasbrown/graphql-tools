import { defaultFieldResolver, GraphQLSchema, GraphQLFieldResolver } from 'graphql';

import { IExecutableSchemaDefinition, ILogger } from './Interfaces';

import { SchemaDirectiveVisitor } from './schemaVisitor';
import mergeDeep from './mergeDeep';

import {
  attachDirectiveResolvers,
  assertResolveFunctionsPresent,
  addResolveFunctionsToSchema,
  attachConnectorsToContext,
  addSchemaLevelResolveFunction,
  buildSchemaFromTypeDefinitions,
  decorateWithLogger,
  forEachField,
  SchemaError
} from './generate';

export function makeExecutableSchema<TContext = any>({
  typeDefs,
  resolvers = {},
  connectors,
  logger,
  allowUndefinedInResolve = true,
  resolverValidationOptions = {},
  directiveResolvers = null,
  schemaDirectives = null,
  parseOptions = {},
  inheritResolversFromInterfaces = false
}: IExecutableSchemaDefinition<TContext>) {
  // Validate and clean up arguments
  if (typeof resolverValidationOptions !== 'object') {
    throw new SchemaError('Expected `resolverValidationOptions` to be an object');
  }

  if (!typeDefs) {
    throw new SchemaError('Must provide typeDefs');
  }

  if (!resolvers) {
    throw new SchemaError('Must provide resolvers');
  }

  // We allow passing in an array of resolver maps, in which case we merge them
  const resolverMap = Array.isArray(resolvers)
    ? resolvers.filter(resolverObj => typeof resolverObj === 'object').reduce(mergeDeep, {})
    : resolvers;

  // Arguments are now validated and cleaned up

  let schema = buildSchemaFromTypeDefinitions(typeDefs, parseOptions);

  schema = addResolveFunctionsToSchema({
    schema,
    resolvers: resolverMap,
    resolverValidationOptions,
    inheritResolversFromInterfaces
  });

  assertResolveFunctionsPresent(schema, resolverValidationOptions);

  if (!allowUndefinedInResolve) {
    addCatchUndefinedToSchema(schema);
  }

  if (logger) {
    addErrorLoggingToSchema(schema, logger);
  }

  if (typeof resolvers['__schema'] === 'function') {
    // TODO a bit of a hack now, better rewrite generateSchema to attach it there.
    // not doing that now, because I'd have to rewrite a lot of tests.
    addSchemaLevelResolveFunction(schema, resolvers['__schema'] as GraphQLFieldResolver<any, any>);
  }

  if (connectors) {
    // connectors are optional, at least for now. That means you can just import them in the resolve
    // function if you want.
    attachConnectorsToContext(schema, connectors);
  }

  if (directiveResolvers) {
    attachDirectiveResolvers(schema, directiveResolvers);
  }

  if (schemaDirectives) {
    SchemaDirectiveVisitor.visitSchemaDirectives(schema, schemaDirectives);
  }

  return schema;
}

function decorateToCatchUndefined(
  fn: GraphQLFieldResolver<any, any>,
  hint: string
): GraphQLFieldResolver<any, any> {
  if (typeof fn === 'undefined') {
    fn = defaultFieldResolver;
  }
  return (root, args, ctx, info) => {
    const result = fn(root, args, ctx, info);
    if (typeof result === 'undefined') {
      throw new Error(`Resolve function for "${hint}" returned undefined`);
    }
    return result;
  };
}

export function addCatchUndefinedToSchema(schema: GraphQLSchema): void {
  forEachField(schema, (field, typeName, fieldName) => {
    const errorHint = `${typeName}.${fieldName}`;
    field.resolve = decorateToCatchUndefined(field.resolve, errorHint);
  });
}

export function addErrorLoggingToSchema(schema: GraphQLSchema, logger: ILogger): void {
  if (!logger) {
    throw new Error('Must provide a logger');
  }
  if (typeof logger.log !== 'function') {
    throw new Error('Logger.log must be a function');
  }
  forEachField(schema, (field, typeName, fieldName) => {
    const errorHint = `${typeName}.${fieldName}`;
    field.resolve = decorateWithLogger(field.resolve, logger, errorHint);
  });
}

export * from './generate';
