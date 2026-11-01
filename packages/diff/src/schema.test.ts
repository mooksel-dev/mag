import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createDiff, isCode } from './engine.ts'
import { factDiagram } from './fact.ts'
import { graphqlElements } from './graphql.ts'
import { manifest, manifestElements } from './manifest.ts'
import { prismaElements } from './prisma.ts'
import { proto, protoElements } from './proto.ts'
import { mask } from './scan.ts'
import { significance, withLevels } from './significance.ts'
import { sqlElements } from './sql.ts'
import { terraform, terraformElements } from './terraform.ts'
import type { FileDiff, GitSource, ParsedElement } from './types.ts'

const rows = (els: ParsedElement[]) => els.map((e) => `${e.kind} ${e.decl} ${e.name}: ${e.signature}`)
const byName = (els: ParsedElement[]) => new Map(els.map((e) => [e.name, e]))

test('mask: comments and strings blanked at the same offsets', () => {
  const src = "a -- x;\n'b;''c' $f$ d; $f$ e"
  const m = mask(src, { line: ['--'], quotes: ["'"], sql: true })
  assert.equal(m.length, src.length)
  assert.equal(m, "a      \n'     ' $f$    $f$ e")
  const hcl = 'x = "${f("}")}" # {\ny = <<EOF\n{\nEOF\n}'
  assert.equal(mask(hcl, { line: ['#'], quotes: ['"'], hcl: true }).replace(/\s+/g, ' '), 'x = " " y = <<EOF EOF }')
})

test('sql: tables with columns and constraints, indexes, alters, views, functions; data is one element', () => {
  const els = sqlElements('db/001.sql', `BEGIN;
CREATE TABLE IF NOT EXISTS public.users (
  id bigserial PRIMARY KEY,
  email text NOT NULL DEFAULT 'a;b', -- not a column
  "Full Name" text,
  CONSTRAINT users_email_key UNIQUE (email)
);
CREATE UNIQUE INDEX idx_users_email ON users (lower(email));
ALTER TABLE users ADD COLUMN age int, DROP COLUMN legacy, ALTER COLUMN email SET NOT NULL;
CREATE VIEW active AS SELECT * FROM users;
CREATE OR REPLACE FUNCTION touch(a int) RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN; RETURN NEW; END $$;
DROP TABLE IF EXISTS old_a, old_b;
INSERT INTO users (email) VALUES ('x');
COMMIT;
`)
  assert.deepEqual(rows(els), [
    'entity table users: table users',
    'field column users.id: id bigserial PRIMARY KEY',
    // The same name twice in a file is one element.
    "field column users.email: email text NOT NULL DEFAULT 'a;b'; ALTER COLUMN email SET NOT NULL",
    'field column users.Full Name: "Full Name" text',
    'field constraint users.users_email_key: CONSTRAINT users_email_key UNIQUE (email)',
    'field index users.idx_users_email: UNIQUE INDEX idx_users_email ON users (lower(email))',
    'field add column users.age: ADD COLUMN age int',
    'field drop column users.legacy: DROP COLUMN legacy',
    'entity view active: view active',
    'symbol function touch: touch(a int): trigger',
    'entity drop table old_a: drop table old_a',
    'entity drop table old_b: drop table old_b',
    'symbol statements (top-level): (top-level)',
  ])
  const m = byName(els)
  assert.deepEqual(m.get('users')!.lines, [[2, 7]])
  assert.deepEqual(m.get('users.email')!.lines, [[4, 4], [9, 9]])
  // A new column leaves its table as it was.
  const more = byName(sqlElements('a.sql', 'CREATE TABLE users (\n  id int,\n  age int\n);'))
  assert.equal(more.get('users')!.bodyHash, byName(sqlElements('a.sql', 'create table users (id int);')).get('users')!.bodyHash)
})

test('prisma: models and enums with fields, datasources as infrastructure', () => {
  const els = prismaElements('schema.prisma', `datasource db {
  provider = "postgresql" // comment
  url      = env("DATABASE_URL")
}
model User {
  id    Int    @id @default(autoincrement())
  email String @unique // the email
  @@index([email, id])
}
enum Role {
  USER
}
`)
  assert.deepEqual(rows(els), [
    'infra datasource db: datasource db ("postgresql")',
    'entity model User: model User',
    'field field User.id: id Int @id @default(autoincrement())',
    'field field User.email: email String @unique',
    'field attribute User.@@index([email,id]): @@index([email, id])',
    'entity enum Role: enum Role',
    'field value Role.USER: USER',
  ])
})

test('proto: messages, oneofs, nested messages, enums, services and rpcs; imports by include root', () => {
  const els = protoElements('api/shop.proto', `syntax = "proto3";
package shop.v1;
// message Fake {
message Order {
  string id = 1;
  oneof payment { string card = 4; }
  message Item { string sku = 1; }
}
enum Status { UNKNOWN = 0; }
service Orders {
  rpc Get(GetReq) returns (Order);
  rpc Watch(GetReq) returns (stream Order) { option (x) = 1; }
}
`)
  assert.deepEqual(rows(els), [
    'contract package package: package shop.v1',
    'contract message Order: message Order',
    'contract field Order.id: string id = 1',
    'contract field Order.card: oneof payment: string card = 4',
    'contract message Order.Item: message Item',
    'contract field Order.Item.sku: string sku = 1',
    'contract enum Status: enum Status',
    'contract value Status.UNKNOWN: UNKNOWN = 0',
    'contract service Orders: service Orders',
    'contract rpc Orders.Get: rpc Get(GetReq) returns (Order)',
    'contract rpc Orders.Watch: rpc Watch(GetReq) returns (stream Order)',
  ])
  assert.deepEqual(proto.imports('api/v1/a.proto', 'import "api/common.proto";\nimport public "google/protobuf/any.proto";'), [
    { spec: 'api/common.proto', line: 1 },
    { spec: 'google/protobuf/any.proto', line: 2 },
  ])
  const files = new Set(['api/common.proto', 'proto/x/y.proto'])
  assert.equal(proto.resolve!('api/v1/a.proto', 'api/common.proto', files), 'api/common.proto')
  assert.equal(proto.resolve!('api/v1/a.proto', 'x/y.proto', files), 'proto/x/y.proto')
  assert.equal(proto.resolve!('api/v1/a.proto', 'google/protobuf/any.proto', files), 'ext:google/protobuf')
})

test('graphql: types with fields, operations of Query, extensions, enums, unions', () => {
  const els = graphqlElements('schema.graphql', `"""
The user { type Fake
"""
type User implements Node {
  id: ID!
  "the name"
  name: String
  type: String
  posts(
    first: Int = 10
  ): [Post!]!
}
# type Fake {
type Query {
  user(id: ID!): User
}
extend type Query { me: User }
enum Role { ADMIN }
union Result = User | Error
`)
  assert.deepEqual(rows(els), [
    'contract type User: type User implements Node',
    'contract field User.id: id: ID!',
    'contract field User.name: name: String',
    'contract field User.type: type: String',
    'contract field User.posts: posts( first: Int = 10 ): [Post!]!',
    'contract type Query: type Query',
    'contract query Query.user: user(id: ID!): User',
    'contract query Query.me: me: User',
    'contract enum Role: enum Role',
    'contract value Role.ADMIN: ADMIN',
    'contract union Result: union Result = User | Error',
  ])
})

test('terraform: resources, modules, variables and outputs; strings, interpolation and heredocs do not break blocks', () => {
  const els = terraformElements('infra/main.tf', `provider "aws" { region = var.region }
variable "region" {
  type    = string
  default = "eu-west-1"
}
# resource "fake" "x" {
resource "aws_s3_bucket" "logs" {
  bucket = "\${var.name}-\${lookup(var.m, "}")}"
  policy = <<EOF
{ "x": "{" }
EOF
}
data "aws_iam_policy_document" "p" {}
module "vpc" {
  source = "./modules/vpc"
}
output "bucket" {
  value     = aws_s3_bucket.logs.id
  sensitive = true
}
locals { x = 1 }
`)
  assert.deepEqual(rows(els), [
    'infra provider provider.aws: provider "aws"',
    'contract variable var.region: var.region?: string',
    'infra resource aws_s3_bucket.logs: resource "aws_s3_bucket" "logs"',
    'infra data data.aws_iam_policy_document.p: data "aws_iam_policy_document" "p"',
    'infra module module.vpc: module "vpc" (./modules/vpc)',
    'contract output output.bucket: output.bucket (sensitive)',
    'symbol blocks (top-level): (top-level)',
  ])
  assert.deepEqual(byName(els).get('aws_s3_bucket.logs')!.lines, [[7, 12]])
  const files = new Set(['infra/modules/vpc/main.tf'])
  assert.equal(terraform.resolve!('infra/main.tf', './modules/vpc', files), 'infra/modules/vpc')
  assert.equal(terraform.resolve!('infra/main.tf', './modules/none', files), null)
  assert.equal(terraform.resolve!('infra/main.tf', 'git::https://github.com/a/b.git//sub?ref=v1', files), 'ext:github.com/a/b')
  assert.equal(terraform.resolve!('infra/main.tf', 'terraform-aws-modules/eks/aws', files), 'ext:terraform-aws-modules/eks/aws')
})

test('openapi: operations with parameters and responses, schemas with properties, $ref to files', () => {
  const src = `openapi: 3.0.0
paths:
  /users/{id}:
    parameters:
      - { name: id, in: path }
    get:
      parameters:
        - { name: expand, in: query }
      responses:
        '200': { description: ok }
        '404': { description: no }
    post:
      requestBody: { required: true, content: {} }
      responses: { '201': { description: ok } }
components:
  schemas:
    User:
      type: object
      required: [id]
      properties:
        id: { type: string, format: uuid }
        tags: { type: array, items: { $ref: '#/components/schemas/Tag' } }
        org: { $ref: './org.yaml#/Org' }
`
  const els = manifestElements('api/openapi.yaml', src)
  assert.deepEqual(rows(els), [
    'contract operation GET /users/{id}: GET /users/{id}(id, expand?) → 200 | 404',
    'contract operation POST /users/{id}: POST /users/{id}(id, body) → 201',
    'contract schema User: schema User',
    'contract property User.id: id: string(uuid)',
    'contract property User.tags: tags?: Tag[]',
    'contract property User.org: org?: Org',
  ])
  assert.deepEqual(byName(els).get('GET /users/{id}')!.lines, [[6, 11]])
  // Reformatting (here: to JSON) does not change a hash.
  const json = JSON.stringify({ openapi: '3.0.0', paths: { '/users/{id}': { parameters: [{ name: 'id', in: 'path' }], get: { parameters: [{ name: 'expand', in: 'query' }], responses: { 200: { description: 'ok' }, 404: { description: 'no' } } } } } }, null, 2)
  assert.equal(byName(manifestElements('api/openapi.json', json)).get('GET /users/{id}')!.bodyHash, byName(els).get('GET /users/{id}')!.bodyHash)
  assert.deepEqual(manifest.imports('api/openapi.yaml', src), [{ spec: './org.yaml', line: 23 }])
  assert.equal(manifest.resolve!('api/openapi.yaml', './org.yaml', new Set(['api/org.yaml'])), 'api/org.yaml')
})

test('k8s: one element per object; other YAML and JSON have none and are not code', () => {
  const els = manifestElements('deploy/web.yaml', `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: prod
spec:
  replicas: 2
---
apiVersion: v1
kind: Service
metadata: { name: web }
`)
  assert.deepEqual(rows(els), ['infra Deployment Deployment/web: Deployment web in prod (apps/v1)', 'infra Service Service/web: Service web (v1)'])
  assert.deepEqual(byName(els).get('Service/web')!.lines, [[9, 11]])
  assert.deepEqual(manifest.imports('deploy/kustomization.yaml', 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - web.yaml\n  - ../base\n'), [
    { spec: 'web.yaml', line: 4 },
    { spec: '../base', line: 5 },
  ])
  assert.deepEqual(manifestElements('package.json', '{"name":"x","apiVersion":1}'), [])
  assert.deepEqual(manifestElements('chart/templates/x.yaml', 'apiVersion: v1\nkind: {{ .Values.kind }}\n'), [])
  assert.deepEqual([isCode('package.json'), isCode('deploy/web.yaml'), isCode('db/001.sql'), isCode('main.tf'), isCode('x.hcl')], [false, false, true, true, true])
})

function fakeGit(commits: Record<string, Record<string, string>>): GitSource {
  const blob = (s: string) => createHash('sha1').update(s).digest('hex')
  const all = new Map(Object.values(commits).flatMap((c) => Object.values(c).map((s) => [blob(s), s])))
  const len = (s?: string) => (s ? s.split('\n').length : 0)
  return {
    treeAt: async (_, sha) => Object.entries(commits[sha]).map(([path, s]) => ({ path, blob: blob(s) })),
    blobs: async (_, shas) => new Map(shas.map((s) => [s, all.get(s)!])),
    diffHunks: async (_, base, head) => {
      const [a, b] = [commits[base], commits[head]]
      const out: FileDiff[] = []
      for (const p of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[p] === b[p]) continue
        out.push({ path: p, status: !(p in a) ? 'add' : !(p in b) ? 'del' : 'mod', hunks: [{ oldStart: a[p] ? 1 : 0, oldLines: len(a[p]), newStart: b[p] ? 1 : 0, newLines: len(b[p]) }] })
      }
      return out
    },
  }
}

test('changes: a migration, a schema field, an API operation and a new module dependency, with their levels', async () => {
  const base = {
    'db/schema.prisma': 'model User {\n  id Int @id\n}\n',
    'db/migrations/001.sql': 'CREATE TABLE users (id int);\n',
    'api/openapi.yaml': 'openapi: 3.0.0\npaths:\n  /users:\n    get:\n      responses: { "200": { description: ok } }\n',
    'infra/main.tf': 'resource "aws_s3_bucket" "logs" {\n  bucket = "a"\n}\n',
    'infra/modules/vpc/main.tf': 'variable "cidr" {}\n',
    'package.json': '{"name":"root"}',
  }
  const head = {
    ...base,
    'db/schema.prisma': 'model User {\n  id Int @id\n  email String\n}\n',
    'db/migrations/002.sql': 'ALTER TABLE users ADD COLUMN email text;\n',
    'api/openapi.yaml': 'openapi: 3.0.0\npaths:\n  /users:\n    get:\n      parameters: [{ name: q, in: query }]\n      responses: { "200": { description: ok } }\n',
    'infra/main.tf': 'resource "aws_s3_bucket" "logs" {\n  bucket = "b"\n}\nmodule "vpc" {\n  source = "./modules/vpc"\n}\n',
    'package.json': '{"name":"root","version":"1"}',
  }
  const vocab = { modules: [{ id: 'db', paths: ['db'] }, { id: 'api', paths: ['api'] }, { id: 'infra', paths: ['infra'] }, { id: 'vpc', paths: ['infra/modules/vpc'] }] }
  const cs = await createDiff(fakeGit({ base, head })).changes({ path: '/r', name: 'r' }, 'base', 'head', vocab)
  const els = cs.changes.filter((c) => c.kind !== 'file').map((c) => `${c.diff} ${c.module} ${c.key.replace(/^r:[^#]*#/, '')}${c.part ? ` ${c.part}` : ''} ${significance(c, [])}`)
  assert.deepEqual(els.sort(), [
    'add db users.email high',
    'add db User.email high',
    'add infra module.vpc critical',
    'add infra infra -> vpc high',
    'mod api GET /users signature high',
    'mod infra aws_s3_bucket.logs body high',
  ].sort())
  assert.equal(cs.deterministic, true)
  // The draft of the fact names schema elements by their signature.
  const arch = vocab.modules.map((m) => ({ id: m.id, name: m.id, description: '', uses: [], paths: m.paths }))
  const draft = factDiagram([withLevels(cs, [])], arch, vocab)!
  const lines = draft.modules.flatMap((m) => (m.interface ?? []).map((l) => `${m.id} ${l.diff ?? ''} ${l.text}`))
  assert.deepEqual(lines.sort(), [
    'api add GET /users(q?) → 200',
    'api del GET /users() → 200',
    'db add ADD COLUMN email text',
    'db add email String',
    'infra add module "vpc" (./modules/vpc)',
    'infra mod resource "aws_s3_bucket" "logs"',
  ])
})
