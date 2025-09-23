import prettier from 'prettier'
import type {
  PostgresColumn,
  PostgresFunction,
  PostgresRelationship,
  PostgresSchema,
  PostgresTable,
  PostgresType,
  PostgresView,
} from '../../lib/index.js'
import type { GeneratorMetadata } from '../../lib/generators.js'
import { GENERATE_TYPES_DEFAULT_SCHEMA } from '../constants.js'

type RelationMeta =
  | {
      type: 'to-one'
      sourceKey: string
      targetKey: string
      targetTable: string
    }
  | {
      type: 'to-many'
      joinTable: string
      joinTargetKey: string
      joinSourceKey: string
      targetTable: string
    }

const zodHelperScript = `import { z } from 'zod'

const boolParser = z.union([z.boolean(), z.string()]).transform((val, ctx) => {
  if (typeof val === 'boolean') return val

  if (typeof val === 'string') {
    const lowerVal = val.toLowerCase()
    if (lowerVal === 'false') return false
    if (lowerVal === 'true') return true
  }

  ctx.addIssue({
    code: 'custom',
    message: \`Cannot coerce value to boolean. Received: \${JSON.stringify(
      val
    )} (type: \${typeof val})\`,
  })

  return z.NEVER
})

const intParser = z.union([z.number(), z.string()]).transform((val, ctx) => {
  if (typeof val === 'number') {
    if (!Number.isInteger(val)) {
      ctx.addIssue({
        code: 'custom',
        message: \`Expected integer, received float: \${val}\`,
      })
      return z.NEVER
    }
    return val
  }

  if (typeof val === 'string') {
    const parsed = parseInt(val, 10)
    if (isNaN(parsed) || parsed.toString() !== val) {
      ctx.addIssue({
        code: 'custom',
        message: \`Cannot coerce string to integer. Received: \${JSON.stringify(val)}\`,
      })
      return z.NEVER
    }
    return parsed
  }

  ctx.addIssue({
    code: 'custom',
    message: \`Cannot coerce value to integer. Received: \${JSON.stringify(
      val
    )} (type: \${typeof val})\`,
  })

  return z.NEVER
})

const numberParser = z.union([z.number(), z.string()]).transform((val, ctx) => {
  if (typeof val === 'number') return val

  if (typeof val === 'string') {
    const parsed = parseFloat(val)
    if (isNaN(parsed)) {
      ctx.addIssue({
        code: 'custom',
        message: \`Cannot coerce string to number. Received: \${JSON.stringify(val)}\`,
      })
      return z.NEVER
    }
    return parsed
  }

  ctx.addIssue({
    code: 'custom',
    message: \`Cannot coerce value to number. Received: \${JSON.stringify(
      val
    )} (type: \${typeof val})\`,
  })

  return z.NEVER
})

const dateParser = z.union([z.date(), z.string()]).transform((val, ctx) => {
  if (val instanceof Date) return val

  if (typeof val === 'string') {
    const parsed = new Date(val)
    if (isNaN(parsed.getTime())) {
      ctx.addIssue({
        code: 'custom',
        message: \`Cannot coerce string to date. Received: \${JSON.stringify(val)}\`,
      })
      return z.NEVER
    }
    return parsed
  }

  ctx.addIssue({
    code: 'custom',
    message: \`Cannot coerce value to date. Received: \${JSON.stringify(val)} (type: \${typeof val})\`,
  })

  return z.NEVER
})
`

type ZodGenMode = 'list' | 'insert' | 'update' | 'insert_lenient'

const defaultSchemaName = GENERATE_TYPES_DEFAULT_SCHEMA as string

// Helper functions
const withNullable = (inner: string, isNullable: boolean) =>
  isNullable ? `${inner}.nullable()` : inner

const withArray = (inner: string): string => {
  return `z.array(${inner})`
}

const withOptional = (inner: string): string => {
  return `${inner}.optional()`
}

function withRelationMeta(inner: string, meta: RelationMeta) {
  return `${inner}.meta(${JSON.stringify(meta)})`
}

type ManyToManyMeta = {
  joinTable: string
  leftTable: string
  rightTable: string
  leftKey: string
  rightKey: string
}

function reverseLeftRightForManyToMany(meta: ManyToManyMeta): ManyToManyMeta {
  return {
    joinTable: meta.joinTable,
    leftTable: meta.rightTable,
    rightTable: meta.leftTable,
    leftKey: meta.rightKey,
    rightKey: meta.leftKey,
  }
}

function getManyToManyRelations(meta: GeneratorMetadata) {
  const { tables, relationships } = meta
  const manyToManyRelations: Array<ManyToManyMeta> = []

  // Filter tables to only include those in the default schema
  const defaultSchemaTables = tables.filter((table) => table.schema === defaultSchemaName)

  // Find junction tables (tables that have exactly 2 foreign keys)
  for (const table of defaultSchemaTables) {
    const foreignKeys = relationships.filter((rel) => rel.relation === table.name)

    if (foreignKeys.length === 2) {
      const [leftRel, rightRel] = foreignKeys
      manyToManyRelations.push({
        joinTable: table.name,
        leftTable: leftRel.referenced_relation,
        rightTable: rightRel.referenced_relation,
        leftKey: leftRel.columns[0],
        rightKey: rightRel.columns[0],
      })
    }
  }

  // Create a map of table names to their many-to-many relations
  const tableToManyToMany: Record<string, ManyToManyMeta[]> = {}

  for (const relation of manyToManyRelations) {
    // Add the right table to the left table's many-to-many list
    tableToManyToMany[relation.leftTable] ??= []
    if (!tableToManyToMany[relation.leftTable].some((r) => r.rightTable === relation.rightTable)) {
      tableToManyToMany[relation.leftTable].push(relation)
    }

    // Add the left table to the right table's many-to-many list (reversed)
    const reversedRelation = reverseLeftRightForManyToMany(relation)
    tableToManyToMany[relation.rightTable] ??= []
    if (
      !tableToManyToMany[relation.rightTable].some(
        (r) => r.rightTable === reversedRelation.rightTable
      )
    ) {
      tableToManyToMany[relation.rightTable].push(reversedRelation)
    }
  }

  return { manyToManyRelations, tableToManyToMany }
}

export const apply = async (meta: GeneratorMetadata): Promise<string> => {
  const {
    schemas,
    tables,
    foreignTables,
    views,
    materializedViews,
    columns,
    types,
    relationships,
  } = meta
  const logs: string[] = []
  const log = (info: string) => logs.push(info)
  const { tableToManyToMany } = getManyToManyRelations(meta)
  // Index columns by relation id
  const columnsByTableId = Object.fromEntries<PostgresColumn[]>(
    [...tables, ...foreignTables, ...views, ...materializedViews].map((t) => [t.id, []])
  )
  columns
    .filter((c) => c.table_id in columnsByTableId)
    .sort(({ name: a }, { name: b }) => a.localeCompare(b))
    .forEach((c) => columnsByTableId[c.table_id].push(c))

  // Only emit for the default schema (matches your example)
  const defaultSchema =
    schemas.find((s) => s.name === defaultSchemaName) ??
    schemas[0] ??
    ({
      name: defaultSchemaName,
    } as PostgresSchema)

  const defaultSchemaTables = [...tables, ...foreignTables]
    .filter((t) => t.schema === defaultSchema.name)
    .sort(({ name: a }, { name: b }) => a.localeCompare(b))

  // Helpers are now defined at the top of the file

  const makeListShapeLine = (col: PostgresColumn, ctx: PgTypeCtx) => {
    const base = pgTypeToZodSchema(defaultSchema, col.format, ctx, 'list')
    const z = withNullable(base, col.is_nullable)
    return `${JSON.stringify(col.name)}: ${z}`
  }

  const makeInsertShapeLine = (col: PostgresColumn, ctx: PgTypeCtx, lenient: boolean) => {
    // Optional when: nullable OR identity OR has default
    const isOptional = col.is_nullable || col.is_identity || col.default_value !== null

    // Identity ALWAYS -> forbid value if provided
    if (col.identity_generation === 'ALWAYS') {
      return `${JSON.stringify(col.name)}?: z.never()`
    }

    let z = pgTypeToZodSchema(defaultSchema, col.format, ctx, lenient ? 'insert_lenient' : 'insert')
    z = withNullable(z, col.is_nullable)
    if (isOptional) z = withOptional(z)

    return `${JSON.stringify(col.name)}: ${z}`
  }

  const makeRelationshipShapeLine = (relation: PostgresRelationship, ctx: PgTypeCtx) => {
    let typeVal = `supabaseZodSchemas.${relation.referenced_relation}.list`
    typeVal = withRelationMeta(typeVal, {
      type: 'to-one',
      targetTable: relation.referenced_relation,
      targetKey: relation.referenced_columns[0],
      sourceKey: relation.columns[0]
    })
    typeVal = withNullable(typeVal, true)

    return `get ${relation.referenced_relation}() { return ${typeVal}.optional() }`
  }

  const makeUpdateShapeLine = (col: PostgresColumn, ctx: PgTypeCtx) => {
    // Update: everything optional; identity ALWAYS -> forbid value if provided
    if (col.identity_generation === 'ALWAYS') {
      return `${JSON.stringify(col.name)}?: z.never()`
    }
    let z = pgTypeToZodSchema(defaultSchema, col.format, ctx, 'update')
    z = withNullable(z, col.is_nullable)
    z = withOptional(z)
    return `${JSON.stringify(col.name)}: ${z}`
  }

  // Build the file as a string
  let out = `
/* START GENERATED TYPES */
${zodHelperScript}

export const supabaseZodSchemas = {
  ${defaultSchemaTables
    .map((table) => {
      const ctx: PgTypeCtx = { types, schemas, tables, views }
      const cols = columnsByTableId[table.id] ?? []
      const relevantRels = relationships
        .filter(
          (relationship) =>
            relationship.schema === table.schema &&
            relationship.referenced_schema === table.schema &&
            relationship.relation === table.name
        )
        .sort(
          (a, b) =>
            a.foreign_key_name.localeCompare(b.foreign_key_name) ||
            a.referenced_relation.localeCompare(b.referenced_relation) ||
            JSON.stringify(a.referenced_columns).localeCompare(JSON.stringify(b.referenced_columns))
        )

      const listShape = cols.map((c) => makeListShapeLine(c, ctx)).join(',\n      ')
      const relationshipShape = relevantRels
        .map((rel) => makeRelationshipShapeLine(rel, ctx))
        .join(',\n      ')

      // Get many-to-many relationships for this table
      const manyToManyRels = tableToManyToMany[table.name] || []
      const manyToManyShape = manyToManyRels
        .filter((relatedTable) => {
          // Don't add if there's already a relevant relationship with the same table
          return !relevantRels.some((rel) => rel.referenced_relation === relatedTable.rightTable)
        })
        .map((relatedTable) => {
          let typeVal = `supabaseZodSchemas.${relatedTable.rightTable}.list`
          typeVal = withRelationMeta(typeVal, {
            type: 'to-many',
            joinTable: relatedTable.joinTable,
            joinTargetKey: relatedTable.rightKey,
            joinSourceKey: relatedTable.leftKey,
            targetTable: relatedTable.rightTable,
          })
          return `get ${relatedTable.rightTable}() { return ${withOptional(withArray(typeVal))} }`
        })
        .join(',\n      ')

      const insertShape = cols.map((c) => makeInsertShapeLine(c, ctx, false)).join(',\n      ')
      const insertLenientShape = cols
        .map((c) => makeInsertShapeLine(c, ctx, true))
        .join(',\n      ')
      const updateShape = cols.map((c) => makeUpdateShapeLine(c, ctx)).join(',\n      ')

      // Combine relationship shapes
      const finalListShape = [listShape, relationshipShape, manyToManyShape]
        .filter((shape) => shape.length > 0)
        .join(',\n      ')

      return `${JSON.stringify(table.name)}: {
    list: z.object({
      ${finalListShape}
    }),
    insert: z.object({
      ${insertShape}
    }),
    insert_lenient: z.object({
      ${insertLenientShape}
    }),
    update: z.object({
      ${updateShape}
    }),
  }`
    })
    .join(',\n  ')}
} as const

/**
 * Generation Logs
 * ${logs.join('\n')}
 */
`

  // Format nicely
  out = await prettier.format(out, { parser: 'typescript', semi: false })
  return out
}

type PgTypeCtx = {
  types: PostgresType[]
  schemas: PostgresSchema[]
  tables: PostgresTable[]
  views: PostgresView[]
}

const pgTypeToZodSchema = (
  schema: PostgresSchema,
  pgType: string,
  {
    types,
    schemas,
    tables, // kept for signature compatibility
    views, // kept for signature compatibility
  }: PgTypeCtx,
  mode: ZodGenMode
): string => {
  const integerTypes = new Set(['int2', 'int4', 'int8'])
  const floatTypes = new Set(['float4', 'float8', 'numeric'])

  // Treat time-only as strings; date/timestamp handled below
  const stringTypes = new Set([
    'bytea',
    'bpchar',
    'varchar',
    'text',
    'citext',
    'time',
    'timetz',
    'vector',
  ])

  const dateLikeTypes = new Set(['date', 'timestamp', 'timestamptz'])

  const getEnumVariants = (t: string): string[] | null => {
    const enumTypes = types.filter((type) => type.name === t && type.enums.length > 0)
    if (enumTypes.length === 0) return null
    const preferred = enumTypes.find((t_) => t_.schema === schema.name) || enumTypes[0]
    // Inline variants regardless of whether the enum's schema is in `schemas`
    return preferred.enums.map((v) => JSON.stringify(v))
  }

  // Arrays: leading underscore means array of the inner type
  if (pgType.startsWith('_')) {
    return withArray(
      pgTypeToZodSchema(
        schema,
        pgType.slice(1),
        {
          types,
          schemas,
          tables,
          views,
        },
        mode
      )
    )
  }

  // Enums inline
  {
    const enumVariants = getEnumVariants(pgType)
    if (enumVariants) return `z.enum([${enumVariants.join(', ')}])`
  }

  // Scalars
  if (pgType === 'bool') {
    if (mode === 'insert_lenient') {
      return 'boolParser'
    }
    return 'z.boolean()'
  }

  // Integer types
  if (integerTypes.has(pgType)) {
    if (mode === 'insert_lenient') {
      return 'intParser'
    }
    return 'z.int()'
  }

  // Float/decimal types
  if (floatTypes.has(pgType)) {
    if (mode === 'insert_lenient') {
      return 'numberParser'
    }
    return 'z.number()'
  }

  // Date-like handling differs by mode:
  if (dateLikeTypes.has(pgType)) {
    if (mode === 'list') {
      // Read shapes coerce to Date
      return 'z.coerce.date()'
    } else if (mode === 'insert_lenient') {
      return 'dateParser'
    } else {
      // Write shapes: only Date in, string out (ISO)
      // return 'z.instanceof(Date).transform(d => d.toISOString())'
      return 'z.string()'
    }
  }

  // UUID with format validation
  if (pgType === 'uuid') return 'z.uuid()'

  if (stringTypes.has(pgType)) return 'z.string()'
  if (pgType === 'json' || pgType === 'jsonb') return 'z.any()'
  if (pgType === 'void') return 'z.undefined()'
  if (pgType === 'record') return 'z.record(z.unknown())'

  // Everything else:
  // - composite types
  // - table row types
  // - view row types
  // - ranges (still TBD)
  // - unknowns
  return 'z.unknown()'
}
