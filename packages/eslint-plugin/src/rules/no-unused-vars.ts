import { TSESTree, TSESLint } from '@typescript-eslint/experimental-utils';
import { PatternVisitor } from '@typescript-eslint/scope-manager';
import baseRule from 'eslint/lib/rules/no-unused-vars';
import * as util from '../util';

type MessageIds = util.InferMessageIdsTypeFromRule<typeof baseRule>;
type Options = util.InferOptionsTypeFromRule<typeof baseRule>;

export default util.createRule<Options, MessageIds>({
  name: 'no-unused-vars',
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow unused variables',
      category: 'Variables',
      recommended: 'warn',
      extendsBaseRule: true,
    },
    schema: baseRule.meta.schema,
    messages: baseRule.meta.messages,
  },
  defaultOptions: [],
  create(context) {
    const rules = baseRule.create(context);

    /**
     * Gets a list of TS module definitions for a specified variable.
     * @param variable eslint-scope variable object.
     */
    function getModuleDeclarations(
      variable: TSESLint.Scope.Variable,
    ): TSESTree.TSModuleDeclaration[] {
      const functionDefinitions: TSESTree.TSModuleDeclaration[] = [];

      variable.defs.forEach(def => {
        // FunctionDeclarations
        if (def.type === 'TSModuleName') {
          functionDefinitions.push(def.node);
        }
      });

      return functionDefinitions;
    }

    /**
     * Determine if an identifier is referencing an enclosing module name.
     * @param ref The reference to check.
     * @param nodes The candidate function nodes.
     * @returns True if it's a self-reference, false if not.
     */
    function isSelfReference(
      ref: TSESLint.Scope.Reference,
      nodes: TSESTree.Node[],
    ): boolean {
      let scope: TSESLint.Scope.Scope | null = ref.from;

      while (scope) {
        if (nodes.indexOf(scope.block) >= 0) {
          return true;
        }

        scope = scope.upper;
      }

      return false;
    }

    return {
      ...rules,
      'TSConstructorType, TSConstructSignatureDeclaration, TSDeclareFunction, TSEmptyBodyFunctionExpression, TSFunctionType, TSMethodSignature'(
        node:
          | TSESTree.TSConstructorType
          | TSESTree.TSConstructSignatureDeclaration
          | TSESTree.TSDeclareFunction
          | TSESTree.TSEmptyBodyFunctionExpression
          | TSESTree.TSFunctionType
          | TSESTree.TSMethodSignature,
      ): void {
        // function type signature params create variables because they can be referenced within the signature,
        // but they obviously aren't unused variables for the purposes of this rule.
        for (const param of node.params) {
          visitPattern(param, name => {
            context.markVariableAsUsed(name.name);
          });
        }
      },
      TSEnumDeclaration(): void {
        // enum members create variables because they can be referenced within the enum,
        // but they obviously aren't unused variables for the purposes of this rule.
        const scope = context.getScope();
        for (const variable of scope.variables) {
          context.markVariableAsUsed(variable.name);
        }
      },
      TSMappedType(node): void {
        // mapped types create a variable for their type name, but it's not necessary to reference it,
        // so we shouldn't consider it as unused for the purpose of this rule.
        context.markVariableAsUsed(node.typeParameter.name.name);
      },
      TSModuleDeclaration(): void {
        const childScope = context.getScope();
        const scope = util.nullThrows(
          context.getScope().upper,
          util.NullThrowsReasons.MissingToken(childScope.type, 'upper scope'),
        );
        for (const variable of scope.variables) {
          // check if the only reference to a module's name is a self-reference in its body
          const moduleNodes = getModuleDeclarations(variable);
          const isModuleDefinition = moduleNodes.length > 0;

          if (
            !isModuleDefinition ||
            // ignore unreferenced module definitions, as the base rule will report on them
            variable.references.length === 0
          ) {
            continue;
          }

          const isVariableOnlySelfReferenced = variable.references.every(
            ref => {
              return isSelfReference(ref, moduleNodes);
            },
          );

          if (isVariableOnlySelfReferenced) {
            context.report({
              node: variable.identifiers[0],
              messageId: 'unusedVar',
              data: {
                varName: variable.name,
                action: 'defined',
                additional: '',
              },
            });
          }
        }
      },
      [[
        'TSParameterProperty > AssignmentPattern > Identifier.left',
        'TSParameterProperty > Identifier.parameter',
      ].join(', ')](node: TSESTree.Identifier): void {
        // just assume parameter properties are used as property usage tracking is beyond the scope of this rule
        context.markVariableAsUsed(node.name);
      },
      ':matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression) > Identifier[name="this"].params'(
        node: TSESTree.Identifier,
      ): void {
        // this parameters should always be considered used as they're pseudo-parameters
        context.markVariableAsUsed(node.name);
      },

      // TODO
      '*[declare=true] Identifier'(node: TSESTree.Identifier): void {
        context.markVariableAsUsed(node.name);
        const scope = context.getScope();
        const { variableScope } = scope;
        if (variableScope !== scope) {
          const superVar = variableScope.set.get(node.name);
          if (superVar) {
            superVar.eslintUsed = true;
          }
        }
      },
    };

    function visitPattern(
      node: TSESTree.Node,
      cb: (node: TSESTree.Identifier) => void,
    ): void {
      const visitor = new PatternVisitor({}, node, cb);
      visitor.visit(node);
    }
  },
});
