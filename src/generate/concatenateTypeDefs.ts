import { print, DocumentNode, ASTNode } from 'graphql';
import { ITypedef } from '../Interfaces';

import { SchemaError } from '.';

function concatenateTypeDefs(
  typeDefinitionsAry: ITypedef[],
  calledFunctionRefs = [] as any,
): string {
  let resolvedTypeDefinitions: string[] = [];
  typeDefinitionsAry.forEach((typeDef: ITypedef) => {
    if ((<DocumentNode>typeDef).kind !== undefined) {
      typeDef = print(typeDef as ASTNode);
    }

    if (typeof typeDef === 'function') {
      if (calledFunctionRefs.indexOf(typeDef) === -1) {
        calledFunctionRefs.push(typeDef);
        resolvedTypeDefinitions = resolvedTypeDefinitions.concat(
          concatenateTypeDefs(typeDef(), calledFunctionRefs),
        );
      }
    } else if (typeof typeDef === 'string') {
      resolvedTypeDefinitions.push(typeDef.trim());
    } else {
      const type = typeof typeDef;
      throw new SchemaError(
        `typeDef array must contain only strings and functions, got ${type}`,
      );
    }
  });
  return uniq(resolvedTypeDefinitions.map(x => x.trim())).join('\n');
}

function uniq(array: Array<any>): Array<any> {
  return array.reduce((accumulator, currentValue) => {
    return accumulator.indexOf(currentValue) === -1
      ? [...accumulator, currentValue]
      : accumulator;
  }, []);
}

export default concatenateTypeDefs;
