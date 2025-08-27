# Zod Template

The Zod template generates [Zod](https://zod.dev/) schemas for your PostgreSQL database schema, providing runtime type validation and type inference.

## Usage

### Generate Zod types

```bash
npm run gen:types:zod
```

This will output Zod schemas to stdout. You can redirect it to a file:

```bash
npm run gen:types:zod > database.zod.ts
```

### Using environment variables

```bash
PG_META_GENERATE_TYPES=zod node --loader ts-node/esm src/server/server.ts
```

## Requirements

The generated code requires [Zod](https://zod.dev/) as a dependency in your project:

```bash
npm install zod
```

## Generated Output

The template generates:

### Enums
```typescript
export const PublicUserStatusSchema = z.enum(['ACTIVE', 'INACTIVE'])
export type PublicUserStatus = z.infer<typeof PublicUserStatusSchema>
```

### Table Schemas
```typescript
// Row schema (all fields)
export const PublicUsersRowSchema = z.object({
  id: z.number(),
  name: z.string().nullable(),
  status: PublicUserStatusSchema.nullable(),
  decimal: z.number().nullable()
})

// Insert schema (respects defaults, identity columns)
export const PublicUsersInsertSchema = z.object({
  id: z.number().optional(), // identity column
  name: z.string().nullable().optional(),
  status: PublicUserStatusSchema.nullable().optional(), // has default
  decimal: z.number().nullable().optional()
})

// Update schema (all fields optional)
export const PublicUsersUpdateSchema = z.object({
  id: z.number().optional(),
  name: z.string().nullable().optional(),
  status: PublicUserStatusSchema.nullable().optional(),
  decimal: z.number().nullable().optional()
})

// Inferred types
export type PublicUsersRow = z.infer<typeof PublicUsersRowSchema>
export type PublicUsersInsert = z.infer<typeof PublicUsersInsertSchema>
export type PublicUsersUpdate = z.infer<typeof PublicUsersUpdateSchema>
```

### Views
```typescript
export const PublicTodosViewRowSchema = z.object({
  id: z.number(),
  details: z.string().nullable(),
  "user-id": z.number()
})
export type PublicTodosViewRow = z.infer<typeof PublicTodosViewRowSchema>
```

### Functions
```typescript
export const PublicAddArgsSchema = z.object({
  arg1: z.number(),
  arg2: z.number()
})
export const PublicAddReturnsSchema = z.number()
export type PublicAddArgs = z.infer<typeof PublicAddArgsSchema>
export type PublicAddReturns = z.infer<typeof PublicAddReturnsSchema>
```

### Helper Functions
```typescript
// Validate table inserts
const result = validateTableInsert(PublicUsersInsertSchema, userData)
if (result.success) {
  // result.data is typed as PublicUsersInsert
} else {
  // result.error is a ZodError
}

// Validate table updates
const updateResult = validateTableUpdate(PublicUsersUpdateSchema, updateData)

// Validate function arguments
const argsResult = validateFunctionArgs(PublicAddArgsSchema, functionArgs)
```

## Features

- **Runtime Validation**: Validate data at runtime with detailed error messages
- **Type Inference**: Get full TypeScript types from your schemas
- **Nullable Fields**: Proper handling of nullable database columns
- **Identity Columns**: Respects ALWAYS generated identity columns
- **Default Values**: Optional fields for columns with defaults
- **Enums**: Database enums become Zod enums
- **Composite Types**: Custom PostgreSQL types become Zod objects
- **Arrays**: PostgreSQL arrays become Zod arrays
- **JSON/JSONB**: Recursive JSON schema support
- **Functions**: Validate function arguments and return types
- **Views**: Support for both regular and materialized views

## Example Usage

```typescript
import { PublicUsersInsertSchema, PublicUsersRowSchema } from './database.zod'

// Validate user input before database insert
const userData = {
  name: "John Doe",
  status: "ACTIVE" as const
}

const validation = validateTableInsert(PublicUsersInsertSchema, userData)
if (!validation.success) {
  console.error('Validation failed:', validation.error.issues)
  return
}

// validation.data is now typed and validated
const user = validation.data

// Parse database response
const dbRow = PublicUsersRowSchema.parse(rowFromDatabase)
```

## Configuration

The Zod template supports the same configuration as other templates:

- `GENERATE_TYPES_INCLUDED_SCHEMAS`: Comma-separated list of schemas to include
- Standard postgres-meta connection environment variables

Example:
```bash
GENERATE_TYPES_INCLUDED_SCHEMAS=public,auth npm run gen:types:zod
```
