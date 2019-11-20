/* tslint:disable:no-unused-expression */

import { expect } from 'chai';
import {
  GraphQLSchema,
  GraphQLNamedType,
  graphql,
  Kind,
  SelectionSetNode,
  print,
  parse,
} from 'graphql';
import { makeExecutableSchema } from '../makeExecutableSchema';
import { propertySchema, bookingSchema } from './testingSchemas';
import delegateToSchema from '../stitching/delegateToSchema';
import {
  transformSchema,
  RenameTypes,
  FilterTypes,
  WrapQuery,
  ExtractField,
  ReplaceFieldWithFragment,
  FilterToSchema,
} from '../transforms';

describe('transforms', () => {
  describe('rename type', () => {
    let schema: GraphQLSchema;
    before(() => {
      const transforms = [
        new RenameTypes(
          (name: string) =>
            ({
              Property: 'House',
              Location: 'Spots',
              TestInterface: 'TestingInterface',
              DateTime: 'Datum',
              InputWithDefault: 'DefaultingInput',
              TestInterfaceKind: 'TestingInterfaceKinds',
              TestImpl1: 'TestImplementation1',
            }[name]),
        ),
      ];
      schema = transformSchema(propertySchema, transforms);
    });
    it('should work', async () => {
      const result = await graphql(
        schema,
        `
          query($input: DefaultingInput!) {
            interfaceTest(kind: ONE) {
              ... on TestingInterface {
                testString
              }
            }
            propertyById(id: "p1") {
              ... on House {
                id
              }
            }
            dateTimeTest
            defaultInputTest(input: $input)
          }
        `,
        {},
        {},
        {
          input: {
            test: 'bar',
          },
        },
      );

      expect(result).to.deep.equal({
        data: {
          dateTimeTest: '1987-09-25T12:00:00',
          defaultInputTest: 'bar',
          interfaceTest: {
            testString: 'test',
          },
          propertyById: {
            id: 'p1',
          },
        },
      });
    });
  });

  describe('namespace', () => {
    let schema: GraphQLSchema;
    before(() => {
      const transforms = [
        new RenameTypes((name: string) => `Property_${name}`),
      ];
      schema = transformSchema(propertySchema, transforms);
    });
    it('should work', async () => {
      const result = await graphql(
        schema,
        `
          query($input: Property_InputWithDefault!) {
            interfaceTest(kind: ONE) {
              ... on Property_TestInterface {
                testString
              }
            }
            properties(limit: 1) {
              __typename
              id
            }
            propertyById(id: "p1") {
              ... on Property_Property {
                id
              }
            }
            dateTimeTest
            defaultInputTest(input: $input)
          }
        `,
        {},
        {},
        {
          input: {
            test: 'bar',
          },
        },
      );

      expect(result).to.deep.equal({
        data: {
          dateTimeTest: '1987-09-25T12:00:00',
          defaultInputTest: 'bar',
          interfaceTest: {
            testString: 'test',
          },
          properties: [
            {
              __typename: 'Property_Property',
              id: 'p1',
            },
          ],
          propertyById: {
            id: 'p1',
          },
        },
      });
    });
  });

  describe('filter to schema', () => {
    let filter: FilterToSchema;
    before(() => {
      filter = new FilterToSchema(bookingSchema);
    });

    it('should remove empty selection sets on objects', async () => {
      const query = parse(`
      query customerQuery($id: ID!) {
        customerById(id: $id) {
          id
          name
          address {
            planet
          }
        }
      }
      `);
      const filteredQuery = filter.transformRequest({
        document: query,
        variables: {
          id: 'c1'
        }
      });

      const expected = parse(`
      query customerQuery($id: ID!) {
        customerById(id: $id) {
          id
          name
        }
      }
      `);
      expect(print(filteredQuery.document)).to.equal(print(expected));
    });

    it('should also remove variables when removing empty selection sets', async () => {
      const query = parse(`
      query customerQuery($id: ID!, $limit: Int) {
        customerById(id: $id) {
          id
          name
          bookings(limit: $limit) {
            paid
          }
        }
      }
      `);
      const filteredQuery = filter.transformRequest({
        document: query,
        variables: {
          id: 'c1',
          limit: 10
        }
      });

      const expected = parse(`
      query customerQuery($id: ID!) {
        customerById(id: $id) {
          id
          name
        }
      }
      `);
      expect(print(filteredQuery.document)).to.equal(print(expected));
    });

    it('should remove empty selection sets on wrapped objects (non-nullable/lists)', async () => {
      const query = parse(`
      query bookingQuery($id: ID!) {
        bookingById(id: $id) {
          id
          propertyId
          customer {
            favoriteFood
          }
        }
      }
      `);
      const filteredQuery = filter.transformRequest({
        document: query,
        variables: {
          id: 'b1'
        }
      });

      const expected = parse(`
      query bookingQuery($id: ID!) {
        bookingById(id: $id) {
          id
          propertyId
        }
      }
      `);
      expect(print(filteredQuery.document)).to.equal(print(expected));
    });
  });

  describe('filter type', () => {
    let schema: GraphQLSchema;
    before(() => {
      const typeNames = ['ID', 'String', 'DateTime', 'Query', 'Booking'];
      const transforms = [
        new FilterTypes(
          (type: GraphQLNamedType) => typeNames.indexOf(type.name) >= 0,
        ),
      ];
      schema = transformSchema(bookingSchema, transforms);
    });

    it('should work normally', async () => {
      const result = await graphql(
        schema,
        `
          query {
            bookingById(id: "b1") {
              id
              propertyId
              startTime
              endTime
            }
          }
        `,
      );

      expect(result).to.deep.equal({
        data: {
          bookingById: {
            endTime: '2016-06-03',
            id: 'b1',
            propertyId: 'p1',
            startTime: '2016-05-04',
          },
        },
      });
    });

    it('should error on removed types', async () => {
      const result = await graphql(
        schema,
        `
          query {
            bookingById(id: "b1") {
              id
              propertyId
              startTime
              endTime
              customer {
                id
              }
            }
          }
        `,
      );
      expect(result.errors).not.to.be.empty;
      expect(result.errors.length).to.equal(1);
      expect(result.errors[0].message).to.equal(
        'Cannot query field "customer" on type "Booking".'
      );
    });
  });

  describe('tree operations', () => {
    let data: any;
    let subSchema: GraphQLSchema;
    let schema: GraphQLSchema;
    before(() => {
      data = {
        u1: {
          id: 'u1',
          username: 'alice',
          address: {
            streetAddress: 'Windy Shore 21 A 7',
            zip: '12345',
          },
        },
        u2: {
          id: 'u2',
          username: 'bob',
          address: {
            streetAddress: 'Snowy Mountain 5 B 77',
            zip: '54321',
          },
        },
      };
      subSchema = makeExecutableSchema({
        typeDefs: `
        type User {
          id: ID!
          username: String
          address: Address
        }

        type Address {
          streetAddress: String
          zip: String
        }

        input UserInput {
          id: ID!
          username: String
        }

        input AddressInput {
          id: ID!
          streetAddress: String
          zip: String
        }

        type Query {
          userById(id: ID!): User
        }

        type Mutation {
          setUser(input: UserInput!): User
          setAddress(input: AddressInput!): Address
        }
      `,
        resolvers: {
          Query: {
            userById(parent, { id }) {
              return data[id];
            },
          },
          Mutation: {
            setUser(parent, { input }) {
              if (data[input.id]) {
                return {
                  ...data[input.id],
                  ...input,
                };
              }
            },
            setAddress(parent, { input }) {
              if (data[input.id]) {
                return {
                  ...data[input.id].address,
                  ...input,
                };
              }
            },
          },
        },
      });
      schema = makeExecutableSchema({
        typeDefs: `
        type User {
          id: ID!
          username: String
          address: Address
        }

        type Address {
          streetAddress: String
          zip: String
        }

        input UserInput {
          id: ID!
          username: String
          streetAddress: String
          zip: String
        }

        type Query {
          addressByUser(id: ID!): Address
        }

        type Mutation {
          setUserAndAddress(input: UserInput!): User
        }
      `,
        resolvers: {
          Query: {
            addressByUser(parent, { id }, context, info) {
              return delegateToSchema({
                schema: subSchema,
                operation: 'query',
                fieldName: 'userById',
                args: { id },
                context,
                info,
                transforms: [
                  // Wrap document takes a subtree as an AST node
                  new WrapQuery(
                    // path at which to apply wrapping and extracting
                    ['userById'],
                    (subtree: SelectionSetNode) => ({
                      // we create a wrapping AST Field
                      kind: Kind.FIELD,
                      name: {
                        kind: Kind.NAME,
                        // that field is `address`
                        value: 'address',
                      },
                      // Inside the field selection
                      selectionSet: subtree,
                    }),
                    // how to process the data result at path
                    result => result && result.address,
                  ),
                ],
              });
            },
          },
          Mutation: {
            async setUserAndAddress(parent, { input }, context, info) {
              const addressResult = await delegateToSchema({
                schema: subSchema,
                operation: 'mutation',
                fieldName: 'setAddress',
                args: {
                  input: {
                    id: input.id,
                    streetAddress: input.streetAddress,
                    zip: input.zip,
                  },
                },
                context,
                info,
                transforms: [
                  // ExtractField takes a path from which to extract the query
                  // for delegation and path to which to move it
                  new ExtractField({
                    from: ['setAddress', 'address'],
                    to: ['setAddress'],
                  }),
                ],
              });
              const userResult = await delegateToSchema({
                schema: subSchema,
                operation: 'mutation',
                fieldName: 'setUser',
                args: {
                  input: {
                    id: input.id,
                    username: input.username,
                  },
                },
                context,
                info,
              });
              return {
                ...userResult,
                address: addressResult,
              };
            },
          },
        },
      });
    });

    it('wrapping delegation', async () => {
      const result = await graphql(
        schema,
        `
          query {
            addressByUser(id: "u1") {
              streetAddress
              zip
            }
          }
        `,
      );

      expect(result).to.deep.equal({
        data: {
          addressByUser: {
            streetAddress: 'Windy Shore 21 A 7',
            zip: '12345',
          },
        },
      });
    });

    it('extracting delegation', async () => {
      const result = await graphql(
        schema,
        `
          mutation($input: UserInput!) {
            setUserAndAddress(input: $input) {
              username
              address {
                zip
                streetAddress
              }
            }
          }

          # fragment UserFragment on User {
          #   address {
          #     zip
          #     ...AddressFragment
          #   }
          # }
          #
          # fragment AddressFragment on Address {
          #   streetAddress
          # }
        `,
        {},
        {},
        {
          input: {
            id: 'u2',
            username: 'new-username',
            streetAddress: 'New Address 555',
            zip: '22222',
          },
        },
      );
      expect(result).to.deep.equal({
        data: {
          setUserAndAddress: {
            username: 'new-username',
            address: {
              streetAddress: 'New Address 555',
              zip: '22222',
            },
          },
        },
      });
    });
  });
  describe('WrapQuery', () => {
    let data: any;
    let subSchema: GraphQLSchema;
    let schema: GraphQLSchema;
    before(() => {
      data = {
        u1: {
          id: 'user1',
          addressStreetAddress: 'Windy Shore 21 A 7',
          addressZip: '12345'
        }
      };
      subSchema = makeExecutableSchema({
        typeDefs: `
        type User {
          id: ID!
          addressStreetAddress: String
          addressZip: String
        }

        type Query {
          userById(id: ID!): User
        }
      `,
        resolvers: {
          Query: {
            userById(parent, { id }) {
              return data[id];
            },
          }
        },
      });
      schema = makeExecutableSchema({
        typeDefs: `
        type User {
          id: ID!
          address: Address
        }

        type Address {
          streetAddress: String
          zip: String
        }

        type Query {
          addressByUser(id: ID!): Address
        }
      `,
        resolvers: {
          Query: {
            addressByUser(parent, { id }, context, info) {
              return delegateToSchema({
                schema: subSchema,
                operation: 'query',
                fieldName: 'userById',
                args: { id },
                context,
                info,
                transforms: [
                  // Wrap document takes a subtree as an AST node
                  new WrapQuery(
                    // path at which to apply wrapping and extracting
                    ['userById'],
                    (subtree: SelectionSetNode) => {
                      const newSelectionSet = {
                        kind: Kind.SELECTION_SET,
                        selections: subtree.selections.map(selection => {
                          // just append fragments, not interesting for this
                          // test
                          if (selection.kind === Kind.INLINE_FRAGMENT ||
                            selection.kind === Kind.FRAGMENT_SPREAD) {
                            return selection;
                          }
                          // prepend `address` to name and camelCase
                          const oldFieldName = selection.name.value;
                          return {
                            kind: Kind.FIELD,
                            name: {
                              kind: Kind.NAME,
                              value: 'address' +
                                oldFieldName.charAt(0).toUpperCase() +
                                oldFieldName.slice(1)
                            }
                          };
                        })
                      };
                      return newSelectionSet;
                    },
                    // how to process the data result at path
                    result => ({
                      streetAddress: result.addressStreetAddress,
                      zip: result.addressZip
                    })
                  ),
                  // Wrap a second level field
                  new WrapQuery(
                    ['userById', 'zip'],
                    (subtree: SelectionSetNode) => subtree,
                    result => result
                  )
                ],
              });
            },
          },
        },
      });
    });

    it('wrapping delegation, returning selectionSet', async () => {
      const result = await graphql(
        schema,
        `
          query {
            addressByUser(id: "u1") {
              streetAddress
              zip
            }
          }
        `,
      );

      expect(result).to.deep.equal({
        data: {
          addressByUser: {
            streetAddress: 'Windy Shore 21 A 7',
            zip: '12345',
          },
        },
      });
    });
  });


  describe('replaces field with fragments', () => {
    let data: any;
    let schema: GraphQLSchema;
    let subSchema: GraphQLSchema;
    before(() => {
      data = {
        u1: {
          id: 'u1',
          name: 'joh',
          surname: 'gats',
        },
      };

      subSchema = makeExecutableSchema({
        typeDefs: `
          type User {
            id: ID!
            name: String!
            surname: String!
          }

          type Query {
            userById(id: ID!): User
          }
        `,
        resolvers: {
          Query: {
            userById(parent, { id }) {
              return data[id];
            },
          },
        },
      });

      schema = makeExecutableSchema({
        typeDefs: `
          type User {
            id: ID!
            name: String!
            surname: String!
            fullname: String!
          }

          type Query {
            userById(id: ID!): User
          }
        `,
        resolvers: {
          Query: {
            userById(parent, { id }, context, info) {
              return delegateToSchema({
                schema: subSchema,
                operation: 'query',
                fieldName: 'userById',
                args: { id },
                context,
                info,
                transforms: [
                  new ReplaceFieldWithFragment(subSchema, [
                    {
                      field: `fullname`,
                      fragment: `fragment UserName on User { name }`,
                    },
                    {
                      field: `fullname`,
                      fragment: `fragment UserSurname on User { surname }`,
                    },
                  ]),
                ],
              });
            },
          },
          User: {
            fullname(parent, args, context, info) {
              return `${parent.name} ${parent.surname}`;
            },
          },
        },
      });
    });
    it('should work', async () => {
      const result = await graphql(
        schema,
        `
          query {
            userById(id: "u1") {
              id
              fullname
            }
          }
        `,
      );

      expect(result).to.deep.equal({
        data: {
          userById: {
            id: 'u1',
            fullname: 'joh gats',
          },
        },
      });
    });
  });
});
