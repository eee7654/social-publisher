import { Model } from 'objection';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { rulesToQuery } = require('@casl/ability/extra');
const { interpret } = require('@ucast/sql/objection');
const { CompoundCondition } = require('@ucast/core');

class CaslQueryBuilder extends Model.QueryBuilder {

    accessibleBy(ability, action = 'read') {
        const rules = rulesToQuery(ability, action, this.modelClass().name, (rule) => {
            if (rule.ast) return rule.ast;
            return rule.conditions; 
        });
        if (rules === null || (rules && Object.keys(rules).length === 0 && rules.constructor === Object)) {
            return this;
        }
        if (!rules || (rules.$or && rules.$or.length === 0)) {
            return this.whereRaw('1 = 0');
        }
        const { $and = [], $or = [] } = rules;
        const condition = new CompoundCondition('and', [
            ...$and,
            new CompoundCondition('or', $or)
        ]);
        return interpret(condition, this);
    }

}

export default CaslQueryBuilder;