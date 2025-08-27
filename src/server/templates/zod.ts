import prettier from 'prettier'
import type {
  PostgresColumn,
  PostgresFunction,
  PostgresSchema,
  PostgresTable,
  PostgresType,
  PostgresView,
} from '../../lib/index.js'
import type { GeneratorMetadata } from '../../lib/generators.js'

export const apply = async ({
  schemas,
  tables,
  foreignTables,
  views,
  materializedViews,
  columns,
  relationships,
  functions,
  types,
}: GeneratorMetadata): Promise<string> => {
  const columnsByTableId = Object.fromEntries<PostgresColumn[]>(
    [...tables, ...foreignTables, ...views, ...materializedViews].map((t) => [t.id, []])
  )
  columns
    .filter((c) => c.table_id in columnsByTableId)
    .sort(({ name: a }, { name: b }) => a.localeCompare(b))
    .forEach((c) => columnsByTableId[c.table_id].push(c))

  let output = `
import { z } from 'zod'

// JSON type for complex fields
export const JsonSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.lazy(() => z.record(JsonSchema)),
  z.lazy(() => z.array(JsonSchema)),
])

export type Json = z.infer<typeof JsonSchema>

// Enum schemas
${schemas
  .sort(({ name: a }, { name: b }) => a.localeCompare(b))
  .map((schema) => {
    const schemaEnums = types
      .filter((type) => type.schema === schema.name && type.enums.length > 0)
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
    
    if (schemaEnums.length === 0) return ''
    
    return `// ${schema.name} schema enums
${schemaEnums.map(
  (enum_) =>
    `export const ${toPascalCase(schema.name)}${toPascalCase(enum_.name)}Schema = z.enum([${enum_.enums
      .map((variant) => JSON.stringify(variant))
      .join(', ')}])
export type ${toPascalCase(schema.name)}${toPascalCase(enum_.name)} = z.infer<typeof ${toPascalCase(schema.name)}${toPascalCase(enum_.name)}Schema>`
).join('\n\n')}`
  })
  .filter(Boolean)
  .join('\n\n')}

// Composite type schemas
${schemas
  .sort(({ name: a }, { name: b }) => a.localeCompare(b))
  .map((schema) => {
    const schemaCompositeTypes = types
      .filter((type) => type.schema === schema.name && type.attributes.length > 0)
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
    
    if (schemaCompositeTypes.length === 0) return ''
    
    return `// ${schema.name} schema composite types
${schemaCompositeTypes.map(
  ({ name, attributes }) =>
    `export const ${toPascalCase(schema.name)}${toPascalCase(name)}Schema = z.object({
  ${attributes.map(({ name, type_id }) => {
    const type = types.find(({ id }) => id === type_id)
    let zodType = 'z.unknown()'
    if (type) {
      zodType = pgTypeToZodType(schema, type.name, { types, schemas, tables, views })
    }
    return `${JSON.stringify(name)}: ${zodType}.nullable()`
  }).join(',\n  ')}
})
export type ${toPascalCase(schema.name)}${toPascalCase(name)} = z.infer<typeof ${toPascalCase(schema.name)}${toPascalCase(name)}Schema>`
).join('\n\n')}`
  })
  .filter(Boolean)
  .join('\n\n')}

// Table schemas
${schemas
  .sort(({ name: a }, { name: b }) => a.localeCompare(b))
  .map((schema) => {
    const schemaTables = [...tables, ...foreignTables]
      .filter((table) => table.schema === schema.name)
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
    
    if (schemaTables.length === 0) return ''
    
    return `// ${schema.name} schema tables
${schemaTables.map((table) => {
  const tableColumns = columnsByTableId[table.id]
  
  // Row schema (all fields)
  const rowSchema = `export const ${toPascalCase(schema.name)}${toPascalCase(table.name)}RowSchema = z.object({
  ${tableColumns.map((column) => {
    const zodType = pgTypeToZodType(schema, column.format, { types, schemas, tables, views })
    const nullable = column.is_nullable ? '.nullable()' : ''
    return `${JSON.stringify(column.name)}: ${zodType}${nullable}`
  }).join(',\n  ')}
})`

  // Insert schema (optional/required fields based on defaults, identity, etc.)
  const insertSchema = `export const ${toPascalCase(schema.name)}${toPascalCase(table.name)}InsertSchema = z.object({
  ${tableColumns.map((column) => {
    if (column.identity_generation === 'ALWAYS') {
      return `${JSON.stringify(column.name)}: z.never().optional()`
    }
    
    const zodType = pgTypeToZodType(schema, column.format, { types, schemas, tables, views })
    const nullable = column.is_nullable ? '.nullable()' : ''
    const optional = column.is_nullable || column.is_identity || column.default_value !== null ? '.optional()' : ''
    
    return `${JSON.stringify(column.name)}: ${zodType}${nullable}${optional}`
  }).join(',\n  ')}
})`

  // Update schema (all fields optional)
  const updateSchema = `export const ${toPascalCase(schema.name)}${toPascalCase(table.name)}UpdateSchema = z.object({
  ${tableColumns.map((column) => {
    if (column.identity_generation === 'ALWAYS') {
      return `${JSON.stringify(column.name)}: z.never().optional()`
    }
    
    const zodType = pgTypeToZodType(schema, column.format, { types, schemas, tables, views })
    const nullable = column.is_nullable ? '.nullable()' : ''
    
          return `${JSON.stringify(column.name)}: ${zodType}${nullable}.optional()`
  }).join(',\n  ')}
})`

  // Types
  const typeExports = `export type ${toPascalCase(schema.name)}${toPascalCase(table.name)}Row = z.infer<typeof ${toPascalCase(schema.name)}${toPascalCase(table.name)}RowSchema>
export type ${toPascalCase(schema.name)}${toPascalCase(table.name)}Insert = z.infer<typeof ${toPascalCase(schema.name)}${toPascalCase(table.name)}InsertSchema>
export type ${toPascalCase(schema.name)}${toPascalCase(table.name)}Update = z.infer<typeof ${toPascalCase(schema.name)}${toPascalCase(table.name)}UpdateSchema>`

  return [rowSchema, insertSchema, updateSchema, typeExports].join('\n\n')
}).join('\n\n')}`
  })
  .filter(Boolean)
  .join('\n\n')}

// View schemas
${schemas
  .sort(({ name: a }, { name: b }) => a.localeCompare(b))
  .map((schema) => {
    const schemaViews = [...views, ...materializedViews]
      .filter((view) => view.schema === schema.name)
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
    
    if (schemaViews.length === 0) return ''
    
    return `// ${schema.name} schema views
${schemaViews.map((view) => {
  const viewColumns = columnsByTableId[view.id]
  
  // Row schema
  const rowSchema = `export const ${toPascalCase(schema.name)}${toPascalCase(view.name)}RowSchema = z.object({
  ${viewColumns.map((column) => {
    const zodType = pgTypeToZodType(schema, column.format, { types, schemas, tables, views })
    const nullable = column.is_nullable ? '.nullable()' : ''
    return `${JSON.stringify(column.name)}: ${zodType}${nullable}`
  }).join(',\n  ')}
})`

  // Update/Insert schemas for updatable views
  let insertUpdateSchemas = ''
  if ('is_updatable' in view && view.is_updatable) {
    const insertSchema = `export const ${toPascalCase(schema.name)}${toPascalCase(view.name)}InsertSchema = z.object({
  ${viewColumns.map((column) => {
    if (!column.is_updatable) {
      return `${JSON.stringify(column.name)}: z.never().optional()`
    }
    
    const zodType = pgTypeToZodType(schema, column.format, { types, schemas, tables, views })
    
    return `${column.name}: ${zodType}.nullable().optional()`
  }).join(',\n  ')}
})`

    const updateSchema = `export const ${toPascalCase(schema.name)}${toPascalCase(view.name)}UpdateSchema = z.object({
  ${viewColumns.map((column) => {
    if (!column.is_updatable) {
      return `${JSON.stringify(column.name)}: z.never().optional()`
    }
    
    const zodType = pgTypeToZodType(schema, column.format, { types, schemas, tables, views })
    
    return `${column.name}: ${zodType}.nullable().optional()`
  }).join(',\n  ')}
})`

    insertUpdateSchemas = `\n\n${insertSchema}\n\n${updateSchema}`
  }

  // Types
  const typeExports = `export type ${toPascalCase(schema.name)}${toPascalCase(view.name)}Row = z.infer<typeof ${toPascalCase(schema.name)}${toPascalCase(view.name)}RowSchema>`
  const insertUpdateTypes = ('is_updatable' in view && view.is_updatable) 
    ? `\nexport type ${toPascalCase(schema.name)}${toPascalCase(view.name)}Insert = z.infer<typeof ${toPascalCase(schema.name)}${toPascalCase(view.name)}InsertSchema>
export type ${toPascalCase(schema.name)}${toPascalCase(view.name)}Update = z.infer<typeof ${toPascalCase(schema.name)}${toPascalCase(view.name)}UpdateSchema>`
    : ''

  return [rowSchema, insertUpdateSchemas, typeExports, insertUpdateTypes].filter(Boolean).join('\n\n')
}).join('\n\n')}`
  })
  .filter(Boolean)
  .join('\n\n')}

// Function schemas
${schemas
  .sort(({ name: a }, { name: b }) => a.localeCompare(b))
  .map((schema) => {
    const schemaFunctions = functions
      .filter((func) => {
        if (func.schema !== schema.name) {
          return false
        }

        // Either:
        // 1. All input args are be named, or
        // 2. There is only one input arg which is unnamed
        const inArgs = func.args.filter(({ mode }) => ['in', 'inout', 'variadic'].includes(mode))

        if (!inArgs.some(({ name }) => name === '')) {
          return true
        }

        if (inArgs.length === 1) {
          return true
        }

        return false
      })
      .sort(({ name: a }, { name: b }) => a.localeCompare(b))
    
    if (schemaFunctions.length === 0) return ''
    
    const schemaFunctionsGroupedByName = schemaFunctions.reduce(
      (acc, curr) => {
        acc[curr.name] ??= []
        acc[curr.name].push(curr)
        return acc
      },
      {} as Record<string, PostgresFunction[]>
    )

    return `// ${schema.name} schema functions
${Object.entries(schemaFunctionsGroupedByName).map(([fnName, fns]) => {
  // Args schema
  const argsSchemas = fns.map((fn) => {
    const inArgs = fn.args
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .filter(({ mode }) => mode === 'in')

    if (inArgs.length === 0) {
      return 'z.object({})'
    }

    const argsNameAndType = inArgs.map(({ name, type_id, has_default }) => {
      const type = types.find(({ id }) => id === type_id)
      let zodType = 'z.unknown()'
      if (type) {
        zodType = pgTypeToZodType(schema, type.name, { types, schemas, tables, views })
      }
      const optional = has_default ? '.optional()' : ''
      return `${JSON.stringify(name)}: ${zodType}${optional}`
    })
    
    return `z.object({ ${argsNameAndType.join(', ')} })`
  })

  const argsSchema = argsSchemas.length === 1 
    ? argsSchemas[0] 
    : `z.union([${argsSchemas.join(', ')}])`

  // Returns schema
  let returnsSchema = 'z.unknown()'
  
  // Case 1: `returns table`.
  const tableArgs = fns[0].args.filter(({ mode }) => mode === 'table')
  if (tableArgs.length > 0) {
    const argsNameAndType = tableArgs.map(({ name, type_id }) => {
      const type = types.find(({ id }) => id === type_id)
      let zodType = 'z.unknown()'
      if (type) {
        zodType = pgTypeToZodType(schema, type.name, { types, schemas, tables, views })
      }
      return `${JSON.stringify(name)}: ${zodType}`
    })

    returnsSchema = `z.object({ ${argsNameAndType.toSorted((a, b) => a.split(':')[0].localeCompare(b.split(':')[0])).join(', ')} })`
  } else {
    // Case 2: returns a relation's row type.
    const relation = [...tables, ...views].find(
      ({ id }) => id === fns[0].return_type_relation_id
    )
    if (relation) {
      returnsSchema = `${toPascalCase(schema.name)}${toPascalCase(relation.name)}RowSchema`
    } else {
      // Case 3: returns base/array/composite/enum type.
      const type = types.find(({ id }) => id === fns[0].return_type_id)
      if (type) {
        returnsSchema = pgTypeToZodType(schema, type.name, { types, schemas, tables, views })
      }
    }
  }

  if (fns[0].is_set_returning_function) {
    returnsSchema = `z.array(${returnsSchema})`
  }

  return `export const ${toPascalCase(schema.name)}${toPascalCase(fnName)}ArgsSchema = ${argsSchema}
export const ${toPascalCase(schema.name)}${toPascalCase(fnName)}ReturnsSchema = ${returnsSchema}
export type ${toPascalCase(schema.name)}${toPascalCase(fnName)}Args = z.infer<typeof ${toPascalCase(schema.name)}${toPascalCase(fnName)}ArgsSchema>
export type ${toPascalCase(schema.name)}${toPascalCase(fnName)}Returns = z.infer<typeof ${toPascalCase(schema.name)}${toPascalCase(fnName)}ReturnsSchema>`
}).join('\n\n')}`
  })
  .filter(Boolean)
  .join('\n\n')}

// Helper functions for validation
export const validateTableInsert = <T extends Record<string, any>>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: z.ZodError } => {
  const result = schema.safeParse(data)
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error }
}

export const validateTableUpdate = <T extends Record<string, any>>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: z.ZodError } => {
  const result = schema.safeParse(data)
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error }
}

export const validateFunctionArgs = <T extends Record<string, any>>(
  schema: z.ZodSchema<T>,
  args: unknown
): { success: true; data: T } | { success: false; error: z.ZodError } => {
  const result = schema.safeParse(args)
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error }
}
`

  output = await prettier.format(output, {
    parser: 'typescript',
    semi: false,
  })
  return output
}

// Helper function to convert snake_case to PascalCase
const toPascalCase = (str: string): string => {
  return str
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('')
}

// TODO: Make this more robust. Currently doesn't handle range types - returns them as unknown.
const pgTypeToZodType = (
  schema: PostgresSchema,
  pgType: string,
  {
    types,
    schemas,
    tables,
    views,
  }: {
    types: PostgresType[]
    schemas: PostgresSchema[]
    tables: PostgresTable[]
    views: PostgresView[]
  }
): string => {
  if (pgType === 'bool') {
    return 'z.boolean()'
  } else if (['int2', 'int4', 'int8', 'float4', 'float8', 'numeric'].includes(pgType)) {
    return 'z.number()'
  } else if (
    [
      'bytea',
      'bpchar',
      'varchar',
      'date',
      'text',
      'citext',
      'time',
      'timetz',
      'timestamp',
      'timestamptz',
      'uuid',
      'vector',
    ].includes(pgType)
  ) {
    return 'z.string()'
  } else if (['json', 'jsonb'].includes(pgType)) {
    return 'JsonSchema'
  } else if (pgType === 'void') {
    return 'z.undefined()'
  } else if (pgType === 'record') {
    return 'z.record(z.unknown())'
  } else if (pgType.startsWith('_')) {
    return `z.array(${pgTypeToZodType(schema, pgType.substring(1), {
      types,
      schemas,
      tables,
      views,
    })})`
  } else {
    const enumTypes = types.filter((type) => type.name === pgType && type.enums.length > 0)
    if (enumTypes.length > 0) {
      const enumType = enumTypes.find((type) => type.schema === schema.name) || enumTypes[0]
      if (schemas.some(({ name }) => name === enumType.schema)) {
        return `${toPascalCase(enumType.schema)}${toPascalCase(enumType.name)}Schema`
      }
      return `z.enum([${enumType.enums.map((variant) => JSON.stringify(variant)).join(', ')}])`
    }

    const compositeTypes = types.filter(
      (type) => type.name === pgType && type.attributes.length > 0
    )
    if (compositeTypes.length > 0) {
      const compositeType =
        compositeTypes.find((type) => type.schema === schema.name) || compositeTypes[0]
      if (schemas.some(({ name }) => name === compositeType.schema)) {
        return `${toPascalCase(compositeType.schema)}${toPascalCase(compositeType.name)}Schema`
      }
      return 'z.unknown()'
    }

    const tableRowTypes = tables.filter((table) => table.name === pgType)
    if (tableRowTypes.length > 0) {
      const tableRowType =
        tableRowTypes.find((type) => type.schema === schema.name) || tableRowTypes[0]
      if (schemas.some(({ name }) => name === tableRowType.schema)) {
        return `${toPascalCase(tableRowType.schema)}${toPascalCase(tableRowType.name)}RowSchema`
      }
      return 'z.unknown()'
    }

    const viewRowTypes = views.filter((view) => view.name === pgType)
    if (viewRowTypes.length > 0) {
      const viewRowType =
        viewRowTypes.find((type) => type.schema === schema.name) || viewRowTypes[0]
      if (schemas.some(({ name }) => name === viewRowType.schema)) {
        return `${toPascalCase(viewRowType.schema)}${toPascalCase(viewRowType.name)}RowSchema`
      }
      return 'z.unknown()'
    }

    return 'z.unknown()'
  }
}
