import { Knex } from 'knex';
import { clone, get, isPlainObject, set } from 'lodash';
import { customAlphabet } from 'nanoid';
import validate from 'uuid-validate';
import { InvalidQueryException } from '../exceptions';
import { Aggregate, Filter, Query, Relation, SchemaOverview } from '../types';
import { applyFunctionToColumnName } from './apply-function-to-column-name';
import { getColumn } from './get-column';
import { getRelationType } from './get-relation-type';
import { getGeometryHelper } from '../database/helpers/geometry';

const generateAlias = customAlphabet('abcdefghijklmnopqrstuvwxyz', 5);

/**
 * Apply the Query to a given Knex query builder instance
 */
export default function applyQuery(
	knex: Knex,
	collection: string,
	dbQuery: Knex.QueryBuilder,
	query: Query,
	schema: SchemaOverview,
	subQuery = false
): void {
	if (query.sort) {
		dbQuery.orderBy(
			query.sort.map((sort) => ({
				...sort,
				column: getColumn(knex, collection, sort.column, false) as any,
			}))
		);
	}

	if (typeof query.limit === 'number') {
		dbQuery.limit(query.limit);
	}

	if (query.offset) {
		dbQuery.offset(query.offset);
	}

	if (query.page && query.limit) {
		dbQuery.offset(query.limit * (query.page - 1));
	}

	if (query.filter) {
		applyFilter(knex, schema, dbQuery, query.filter, collection, subQuery);
	}

	if (query.search) {
		applySearch(schema, dbQuery, query.search, collection);
	}

	if (query.group) {
		dbQuery.groupBy(query.group.map(applyFunctionToColumnName));
	}

	if (query.aggregate) {
		applyAggregate(dbQuery, query.aggregate);
	}
}

/**
 * Apply a given filter object to the Knex QueryBuilder instance.
 *
 * Relational nested filters, like the following example:
 *
 * ```json
 * // Fetch pages that have articles written by Rijk
 *
 * {
 *   "articles": {
 *     "author": {
 *       "name": {
 *         "_eq": "Rijk"
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * are handled by joining the nested tables, and using a where statement on the top level on the
 * nested field through the join. This allows us to filter the top level items based on nested data.
 * The where on the root is done with a subquery to prevent duplicates, any nested joins are done
 * with aliases to prevent naming conflicts.
 *
 * The output SQL for the above would look something like:
 *
 * ```sql
 * SELECT *
 * FROM pages
 * WHERE
 *   pages.id in (
 *     SELECT articles.page_id AS page_id
 *     FROM articles
 *     LEFT JOIN authors AS xviqp ON articles.author = xviqp.id
 *     WHERE xviqp.name = 'Rijk'
 *   )
 * ```
 */

export function applyFilter(
	knex: Knex,
	schema: SchemaOverview,
	rootQuery: Knex.QueryBuilder,
	rootFilter: Filter,
	collection: string,
	subQuery = false
): void {
	const relations: Relation[] = schema.relations;

	const aliasMap: Record<string, string> = {};

	addJoins(rootQuery, rootFilter, collection);
	addWhereClauses(knex, rootQuery, rootFilter, collection);

	function addJoins(dbQuery: Knex.QueryBuilder, filter: Filter, collection: string) {
		for (const [key, value] of Object.entries(filter)) {
			if (key === '_or' || key === '_and') {
				// If the _or array contains an empty object (full permissions), we should short-circuit and ignore all other
				// permission checks, as {} already matches full permissions.
				if (key === '_or' && value.some((subFilter: Record<string, any>) => Object.keys(subFilter).length === 0))
					continue;

				value.forEach((subFilter: Record<string, any>) => {
					addJoins(dbQuery, subFilter, collection);
				});

				continue;
			}

			const filterPath = getFilterPath(key, value);

			if (filterPath.length > 1) {
				addJoin(filterPath, collection);
			}
		}

		function addJoin(path: string[], collection: string) {
			path = clone(path);

			followRelation(path);

			function followRelation(pathParts: string[], parentCollection: string = collection, parentAlias?: string) {
				/**
				 * For M2A fields, the path can contain an optional collection scope <field>:<scope>
				 */
				const pathRoot = pathParts[0].split(':')[0];

				const relation = relations.find((relation) => {
					return (
						(relation.collection === parentCollection && relation.field === pathRoot) ||
						(relation.related_collection === parentCollection && relation.meta?.one_field === pathRoot)
					);
				});

				if (!relation) return;

				const relationType = getRelationType({ relation, collection: parentCollection, field: pathRoot });

				const alias = generateAlias();

				set(aliasMap, parentAlias ? [parentAlias, ...pathParts] : pathParts, alias);

				if (relationType === 'm2o') {
					dbQuery.leftJoin(
						{ [alias]: relation.related_collection! },
						`${parentAlias || parentCollection}.${relation.field}`,
						`${alias}.${schema.collections[relation.related_collection!].primary}`
					);
				}

				if (relationType === 'm2a') {
					const pathScope = pathParts[0].split(':')[1];

					if (!pathScope) {
						throw new InvalidQueryException(
							`You have to provide a collection scope when filtering on a many-to-any item`
						);
					}

					dbQuery.leftJoin({ [alias]: pathScope }, (joinClause) => {
						joinClause
							.on(
								`${parentAlias || parentCollection}.${relation.field}`,
								'=',
								`${alias}.${schema.collections[pathScope].primary}`
							)
							.andOnVal(relation.meta!.one_collection_field!, '=', pathScope);
					});
				}

				// Still join o2m relations when in subquery OR when the o2m relation is not at the root level
				if (relationType === 'o2m' && (subQuery === true || parentAlias !== undefined)) {
					dbQuery.leftJoin(
						{ [alias]: relation.collection },
						`${parentAlias || parentCollection}.${schema.collections[relation.related_collection!].primary}`,
						`${alias}.${relation.field}`
					);
				}

				if (relationType === 'm2o' || subQuery === true) {
					let parent: string;

					if (relationType === 'm2o') {
						parent = relation.related_collection!;
					} else if (relationType === 'm2a') {
						const pathScope = pathParts[0].split(':')[1];

						if (!pathScope) {
							throw new InvalidQueryException(
								`You have to provide a collection scope when filtering on a many-to-any item`
							);
						}

						parent = pathScope;
					} else {
						parent = relation.collection;
					}

					pathParts.shift();

					if (pathParts.length) {
						followRelation(pathParts, parent, alias);
					}
				}
			}
		}
	}

	function addWhereClauses(
		knex: Knex,
		dbQuery: Knex.QueryBuilder,
		filter: Filter,
		collection: string,
		logical: 'and' | 'or' = 'and'
	) {
		for (const [key, value] of Object.entries(filter)) {
			if (key === '_or' || key === '_and') {
				// If the _or array contains an empty object (full permissions), we should short-circuit and ignore all other
				// permission checks, as {} already matches full permissions.
				if (key === '_or' && value.some((subFilter: Record<string, any>) => Object.keys(subFilter).length === 0)) {
					continue;
				}

				/** @NOTE this callback function isn't called until Knex runs the query */
				dbQuery[logical].where((subQuery) => {
					value.forEach((subFilter: Record<string, any>) => {
						addWhereClauses(knex, subQuery, subFilter, collection, key === '_and' ? 'and' : 'or');
					});
				});

				continue;
			}

			const filterPath = getFilterPath(key, value);

			/**
			 * For M2A fields, the path can contain an optional collection scope <field>:<scope>
			 */
			const pathRoot = filterPath[0].split(':')[0];

			const relation = relations.find((relation) => {
				return (
					(relation.collection === collection && relation.field === pathRoot) ||
					(relation.related_collection === collection && relation.meta?.one_field === pathRoot)
				);
			});

			const { operator: filterOperator, value: filterValue } = getOperation(key, value);

			const relationType = relation ? getRelationType({ relation, collection: collection, field: pathRoot }) : null;

			if (relationType === 'm2o' || relationType === 'm2a' || relationType === null) {
				if (filterPath.length > 1) {
					const columnName = getWhereColumn(filterPath, collection);
					if (!columnName) continue;
					applyFilterToQuery(columnName, filterOperator, filterValue, logical);
				} else {
					applyFilterToQuery(`${collection}.${filterPath[0]}`, filterOperator, filterValue, logical);
				}
			} else if (subQuery === false) {
				const pkField = `${collection}.${schema.collections[relation!.related_collection!].primary}`;

				dbQuery[logical].whereIn(pkField, (subQueryKnex) => {
					const field = relation!.field;
					const collection = relation!.collection;
					const column = `${collection}.${field}`;
					subQueryKnex.select({ [field]: column }).from(collection);

					applyQuery(
						knex,
						relation!.collection,
						subQueryKnex,
						{
							filter: value,
						},
						schema,
						true
					);
				});
			}
		}

		function applyFilterToQuery(key: string, operator: string, compareValue: any, logical: 'and' | 'or' = 'and') {
			const [table, column] = key.split('.');

			// Is processed through Knex.Raw, so should be safe to string-inject into these where queries
			const selectionRaw = getColumn(knex, table, column, false) as any;

			// Knex supports "raw" in the columnName parameter, but isn't typed as such. Too bad..
			// See https://github.com/knex/knex/issues/4518 @TODO remove as any once knex is updated

			// These operators don't rely on a value, and can thus be used without one (eg `?filter[field][_null]`)
			if (operator === '_null' || (operator === '_nnull' && compareValue === false)) {
				dbQuery[logical].whereNull(selectionRaw);
			}

			if (operator === '_nnull' || (operator === '_null' && compareValue === false)) {
				dbQuery[logical].whereNotNull(selectionRaw);
			}

			if (operator === '_empty' || (operator === '_nempty' && compareValue === false)) {
				dbQuery[logical].andWhere((query) => {
					query.where(key, '=', '');
				});
			}

			if (operator === '_nempty' || (operator === '_empty' && compareValue === false)) {
				dbQuery[logical].andWhere((query) => {
					query.where(key, '!=', '');
				});
			}

			// The following fields however, require a value to be run. If no value is passed, we
			// ignore them. This allows easier use in GraphQL, where you wouldn't be able to
			// conditionally build out your filter structure (#4471)
			if (compareValue === undefined) return;

			if (Array.isArray(compareValue)) {
				// Tip: when using a `[Type]` type in GraphQL, but don't provide the variable, it'll be
				// reported as [undefined].
				// We need to remove any undefined values, as they are useless
				compareValue = compareValue.filter((val) => val !== undefined);
			}

			if (operator === '_eq') {
				dbQuery[logical].where(selectionRaw, '=', compareValue);
			}

			if (operator === '_neq') {
				dbQuery[logical].whereNot(selectionRaw, compareValue);
			}

			if (operator === '_contains') {
				dbQuery[logical].where(selectionRaw, 'like', `%${compareValue}%`);
			}

			if (operator === '_ncontains') {
				dbQuery[logical].whereNot(selectionRaw, 'like', `%${compareValue}%`);
			}

			if (operator === '_starts_with') {
				dbQuery[logical].where(key, 'like', `${compareValue}%`);
			}

			if (operator === '_nstarts_with') {
				dbQuery[logical].whereNot(key, 'like', `${compareValue}%`);
			}

			if (operator === '_ends_with') {
				dbQuery[logical].where(key, 'like', `%${compareValue}`);
			}

			if (operator === '_nends_with') {
				dbQuery[logical].whereNot(key, 'like', `%${compareValue}`);
			}

			if (operator === '_gt') {
				dbQuery[logical].where(selectionRaw, '>', compareValue);
			}

			if (operator === '_gte') {
				dbQuery[logical].where(selectionRaw, '>=', compareValue);
			}

			if (operator === '_lt') {
				dbQuery[logical].where(selectionRaw, '<', compareValue);
			}

			if (operator === '_lte') {
				dbQuery[logical].where(selectionRaw, '<=', compareValue);
			}

			if (operator === '_in') {
				let value = compareValue;
				if (typeof value === 'string') value = value.split(',');

				dbQuery[logical].whereIn(selectionRaw, value as string[]);
			}

			if (operator === '_nin') {
				let value = compareValue;
				if (typeof value === 'string') value = value.split(',');

				dbQuery[logical].whereNotIn(selectionRaw, value as string[]);
			}

			if (operator === '_between') {
				if (compareValue.length !== 2) return;

				let value = compareValue;
				if (typeof value === 'string') value = value.split(',');

				dbQuery[logical].whereBetween(selectionRaw, value);
			}

			if (operator === '_nbetween') {
				if (compareValue.length !== 2) return;

				let value = compareValue;
				if (typeof value === 'string') value = value.split(',');

				dbQuery[logical].whereNotBetween(selectionRaw, value);
			}

			const geometryHelper = getGeometryHelper();

			if (operator == '_intersects') {
				dbQuery[logical].whereRaw(geometryHelper.intersects(key, compareValue));
			}

			if (operator == '_nintersects') {
				dbQuery[logical].whereRaw(geometryHelper.nintersects(key, compareValue));
			}
			if (operator == '_intersects_bbox') {
				dbQuery[logical].whereRaw(geometryHelper.intersects_bbox(key, compareValue));
			}

			if (operator == '_nintersects_bbox') {
				dbQuery[logical].whereRaw(geometryHelper.nintersects_bbox(key, compareValue));
			}
		}

		function getWhereColumn(path: string[], collection: string) {
			return followRelation(path);

			function followRelation(
				pathParts: string[],
				parentCollection: string = collection,
				parentAlias?: string
			): string | void {
				/**
				 * For M2A fields, the path can contain an optional collection scope <field>:<scope>
				 */
				const pathRoot = pathParts[0].split(':')[0];

				const relation = relations.find((relation) => {
					return (
						(relation.collection === parentCollection && relation.field === pathRoot) ||
						(relation.related_collection === parentCollection && relation.meta?.one_field === pathRoot)
					);
				});

				if (!relation) {
					throw new InvalidQueryException(`"${parentCollection}.${pathRoot}" is not a relational field`);
				}

				const relationType = getRelationType({ relation, collection: parentCollection, field: pathRoot });

				const alias = get(aliasMap, parentAlias ? [parentAlias, ...pathParts] : pathParts);

				const remainingParts = pathParts.slice(1);

				let parent: string;

				if (relationType === 'm2a') {
					const pathScope = pathParts[0].split(':')[1];

					if (!pathScope) {
						throw new InvalidQueryException(
							`You have to provide a collection scope when filtering on a many-to-any item`
						);
					}

					parent = pathScope;
				} else if (relationType === 'm2o') {
					parent = relation.related_collection!;
				} else {
					parent = relation.collection;
				}

				if (remainingParts.length === 1) {
					return `${alias || parent}.${remainingParts[0]}`;
				}

				if (remainingParts.length) {
					return followRelation(remainingParts, parent, alias);
				}
			}
		}
	}
}

export async function applySearch(
	schema: SchemaOverview,
	dbQuery: Knex.QueryBuilder,
	searchQuery: string,
	collection: string
): Promise<void> {
	const fields = Object.entries(schema.collections[collection].fields);

	dbQuery.andWhere(function () {
		fields.forEach(([name, field]) => {
			if (['text', 'string'].includes(field.type)) {
				this.orWhereRaw(`LOWER(??) LIKE ?`, [`${collection}.${name}`, `%${searchQuery.toLowerCase()}%`]);
			} else if (['bigInteger', 'integer', 'decimal', 'float'].includes(field.type)) {
				const number = Number(searchQuery);
				if (!isNaN(number)) this.orWhere({ [`${collection}.${name}`]: number });
			} else if (field.type === 'uuid' && validate(searchQuery)) {
				this.orWhere({ [`${collection}.${name}`]: searchQuery });
			}
		});
	});
}

export function applyAggregate(dbQuery: Knex.QueryBuilder, aggregate: Aggregate): void {
	for (const [operation, fields] of Object.entries(aggregate)) {
		if (!fields) continue;

		for (const field of fields) {
			if (operation === 'avg') {
				dbQuery.avg(field, { as: `avg->${field}` });
			}

			if (operation === 'avgDistinct') {
				dbQuery.avgDistinct(field, { as: `avgDistinct->${field}` });
			}

			if (operation === 'count') {
				if (field === '*') {
					dbQuery.count('*', { as: 'count' });
				} else {
					dbQuery.count(field, { as: `count->${field}` });
				}
			}

			if (operation === 'countDistinct') {
				dbQuery.countDistinct(field, { as: `countDistinct->${field}` });
			}

			if (operation === 'sum') {
				dbQuery.sum(field, { as: `sum->${field}` });
			}

			if (operation === 'sumDistinct') {
				dbQuery.sumDistinct(field, { as: `sumDistinct->${field}` });
			}

			if (operation === 'min') {
				dbQuery.min(field, { as: `min->${field}` });
			}

			if (operation === 'max') {
				dbQuery.max(field, { as: `max->${field}` });
			}
		}
	}
}

function getFilterPath(key: string, value: Record<string, any>) {
	const path = [key];

	if (typeof Object.keys(value)[0] === 'string' && Object.keys(value)[0].startsWith('_') === true) {
		return path;
	}

	if (isPlainObject(value)) {
		path.push(...getFilterPath(Object.keys(value)[0], Object.values(value)[0]));
	}

	return path;
}

function getOperation(key: string, value: Record<string, any>): { operator: string; value: any } {
	if (key.startsWith('_') && key !== '_and' && key !== '_or') {
		return { operator: key as string, value };
	} else if (isPlainObject(value) === false) {
		return { operator: '_eq', value };
	}

	return getOperation(Object.keys(value)[0], Object.values(value)[0]);
}
