// =============================================================================
// index.js: the whole API. The page calls these four addresses:
//
//   GET  /api/rows?page=n&size=n  one page of rows
//   GET  /api/search?q=text&page=n&size=n  one page of matching rows
//   POST /api/update            change a uniquely identified row
//   POST /api/add               add a row; SQL assigns its ID
//   POST /api/delete            delete one uniquely identified row
//   POST /api/upload            commit uploaded files to the configured GitHub repo
//
// Every answer is JSON. Problems come back as { "error": "message" }.
//
// ID is the identity primary key used for row-level edits and deletes.
//
// Search values are passed as SQL parameters.
// =============================================================================

const path = require('path');
const crypto = require('crypto');
const sql = require('mssql');
const { app } = require('@azure/functions');

// On your computer, read settings from the .env file in the project folder.
// (In Azure there is no .env file; settings come from the portal.)
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // no .env file: fine
}

// ---- columns ----------------------------------------------------------------

// ID is the table's identity primary key and stable row key.
const COLUMNS = [
  { field: 'id', title: 'ID' },
  { field: 'raw_multi_line_rep', title: 'Raw Multi Line Rep', editable: true, addable: true },
  { field: 'multi_line_rep', title: 'Multi Line Rep', editable: true, addable: true },
  { field: 'mlr_team', title: 'MLR Team', editable: true, addable: true },
  { field: 'mlr_subsidiary', title: 'MLR Subsidiary', editable: true, addable: true },
];

const EDITABLE_COLUMNS = ['raw_multi_line_rep', 'multi_line_rep', 'mlr_team', 'mlr_subsidiary'];
const SQL_COLUMNS = {
  raw_multi_line_rep: 'RAW_MULTI_LINE_REP',
  multi_line_rep: 'MULTI_LINE_REP',
  mlr_team: 'MLR_TEAM',
  mlr_subsidiary: 'MLR_SUBSIDIARY',
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// ---- database connection ------------------------------------------------------
// This application targets the user's HPG_CDW_SB01 database in both environments.
// Credentials come from .env locally or Azure environment variables.

let pool = null;

// Runs SQL. "params" fills in the @names safely. Returns the rows.
async function run(text, params = {}) {
  if (!pool) {
    pool = sql.connect({
      server: 'db-hpg-cdw-sb01.database.windows.net',
      database: 'HPG_CDW_SB01',
      user: process.env.AZURE_SQL_USER,
      password: process.env.AZURE_SQL_PASSWORD,
      options: { encrypt: true },
      connectionTimeout: 30000, // a paused (serverless) database can take ~20s to wake
    }).catch((err) => {
      pool = null; // try again on the next request
      throw err;
    });
  }
  const request = (await pool).request();
  for (const [name, value] of Object.entries(params)) {
    if (name === 'id') request.input(name, sql.BigInt, value);
    else request.input(name, value);
  }
  return (await request.query(text)).recordset || [];
}

// ---- shared password ----------------------------------------------------------
// Everyone uses one password, the APP_PASSWORD setting. The page sends it with
// every request in a header called x-app-password.

function passwordOk(request) {
  const given = request.headers.get('x-app-password') || '';
  // Compare fingerprints in constant time, so timing can't leak the password.
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(process.env.APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

const reply = (status, body) => ({ status, jsonBody: body });

async function githubRequest(endpoint, method = 'GET', body) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `GitHub returned HTTP ${response.status}.`);
  }
  return data;
}

async function commitUploadedFiles(request) {
  if (!process.env.GITHUB_TOKEN) {
    return reply(500, { error: 'GITHUB_TOKEN is not set on the server. See README.' });
  }

  const repository = process.env.GITHUB_REPOSITORY || 'martyscherrhpg/DataUtility';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    return reply(500, { error: 'GITHUB_REPOSITORY must use the owner/repository format.' });
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return reply(400, { error: 'Upload must use multipart form data.' });
  }

  const files = form.getAll('files').filter((file) => typeof file.arrayBuffer === 'function');
  if (!files.length || files.length > 20) {
    return reply(400, { error: 'Choose between 1 and 20 files.' });
  }

  const maxFileSize = 5 * 1024 * 1024;
  const maxUploadSize = 10 * 1024 * 1024;
  let uploadSize = 0;
  const names = new Set();
  for (const file of files) {
    const name = path.posix.basename(file.name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '_');
    if (!name || name === '.' || name === '..' || name.length > 200) {
      return reply(400, { error: 'A file has an invalid name.' });
    }
    if (names.has(name.toLowerCase())) {
      return reply(400, { error: 'Each uploaded file must have a unique name.' });
    }
    names.add(name.toLowerCase());
    if (file.size > maxFileSize) {
      return reply(400, { error: 'Each file must be 5 MB or smaller.' });
    }
    uploadSize += file.size;
  }
  if (uploadSize > maxUploadSize) {
    return reply(400, { error: 'The combined upload must be 10 MB or smaller.' });
  }

  const [owner, repo] = repository.split('/');
  const apiRoot = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const repositoryInfo = await githubRequest(apiRoot);
  const branch = repositoryInfo.default_branch;
  if (!branch) throw new Error('The GitHub repository has no default branch.');

  const reference = await githubRequest(`${apiRoot}/git/ref/heads/${encodeURIComponent(branch)}`);
  const parentCommit = await githubRequest(`${apiRoot}/git/commits/${reference.object.sha}`);
  const directory = `incoming/${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomUUID().slice(0, 8)}`;
  const tree = [];

  for (const file of files) {
    const blob = await githubRequest(`${apiRoot}/git/blobs`, 'POST', {
      content: Buffer.from(await file.arrayBuffer()).toString('base64'),
      encoding: 'base64',
    });
    const name = path.posix.basename(file.name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '_');
    tree.push({ path: `${directory}/${name}`, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await githubRequest(`${apiRoot}/git/trees`, 'POST', {
    base_tree: parentCommit.tree.sha,
    tree,
  });
  const commit = await githubRequest(`${apiRoot}/git/commits`, 'POST', {
    message: `Add ${files.length} uploaded file${files.length === 1 ? '' : 's'} to ${directory}`,
    tree: newTree.sha,
    parents: [reference.object.sha],
  });
  await githubRequest(`${apiRoot}/git/refs/heads/${encodeURIComponent(branch)}`, 'PATCH', { sha: commit.sha });

  return reply(201, { uploaded: true, count: files.length, directory, commitUrl: commit.html_url });
}

// Every endpoint goes through this: check the password, run the handler, and
// turn any crash into a readable error.
function endpoint(name, method, handler) {
  app.http(name, {
    methods: [method],
    authLevel: 'anonymous', // the password check below does the gatekeeping
    handler: async (request, context) => {
      try {
        if (!process.env.APP_PASSWORD) {
          return reply(500, { error: 'APP_PASSWORD is not set on the server. See README.' });
        }
        if (!passwordOk(request)) {
          await new Promise((r) => setTimeout(r, 1000)); // slows down password guessing
          return reply(401, { error: 'Wrong password.', needPassword: true });
        }
        return await handler(request);
      } catch (err) {
        context.error(err);
        return reply(500, { error: err.message || 'Something went wrong.' });
      }
    },
  });
}

function gridColumns() {
  return COLUMNS.map((c) => ({ ...c, editable: Boolean(c.editable), addable: Boolean(c.addable) }));
}

function pageParams(request) {
  const page = Math.max(1, Math.min(1000000, Number.parseInt(request.query.get('page') || '1', 10) || 1));
  const size = Math.max(1, Math.min(MAX_PAGE_SIZE, Number.parseInt(request.query.get('size') || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE));
  return { page, size, offset: (page - 1) * size };
}

async function gridPage(request, searchText = '') {
  const { page, size, offset } = pageParams(request);
  const search = `%${searchText}%`;
  const conditions = searchText ? `WHERE RAW_MULTI_LINE_REP LIKE @search
      OR MULTI_LINE_REP LIKE @search
      OR MLR_TEAM LIKE @search
      OR MLR_SUBSIDIARY LIKE @search
      OR CONVERT(varchar(20), ID) LIKE @search` : '';
  const countResult = await run(`SELECT COUNT_BIG(*) AS total FROM dbo.Multi_Line_Rep_new ${conditions};`, searchText ? { search } : {});
  const result = await run(`
    WITH filtered AS (
      SELECT ID AS id,
        RAW_MULTI_LINE_REP AS raw_multi_line_rep,
        MULTI_LINE_REP AS multi_line_rep, MLR_TEAM AS mlr_team, MLR_SUBSIDIARY AS mlr_subsidiary
      FROM dbo.Multi_Line_Rep_new
      ${conditions}
    ), identified AS (
      SELECT id, CONVERT(bit, 1) AS can_edit,
        raw_multi_line_rep, multi_line_rep, mlr_team, mlr_subsidiary
      FROM filtered
    )
    SELECT CONVERT(varchar(20), id) AS id, can_edit, raw_multi_line_rep, multi_line_rep, mlr_team, mlr_subsidiary
    FROM identified ORDER BY identified.id DESC OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY;`,
    { ...(searchText ? { search } : {}), offset, size });
  return reply(200, {
    rows: result,
    total: Number(countResult[0]?.total || 0), page, pageSize: size,
    columns: gridColumns(),
  });
}

// ---- the endpoints --------------------------------------------------------------

endpoint('rows', 'GET', async (request) => {
  return gridPage(request);
});

endpoint('search', 'GET', async (request) => {
  const q = (request.query.get('q') || '').trim();
  return gridPage(request, q);
});

endpoint('update', 'POST', async (request) => {
  const body = await request.json().catch(() => ({}));
  const id = String(body.id ?? '').trim();
  if (!/^\d+$/.test(id)) return reply(400, { error: 'A valid row ID is required.' });
  if (BigInt(id) > 9223372036854775807n) return reply(400, { error: 'ID is outside the supported range.' });
  const values = {};
  for (const column of EDITABLE_COLUMNS) {
    const value = body.values?.[column] ?? null;
    if (value !== null && (typeof value !== 'string' || value.length > 100)) return reply(400, { error: `${column} must be text of 100 characters or fewer.` });
    values[column] = value;
  }
  const params = { id };
  for (const column of EDITABLE_COLUMNS) params[`value_${column}`] = values[column];

  const result = await run(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @matching_rows bigint;
    DECLARE @changed int = 0;
    SELECT @matching_rows = COUNT_BIG(*)
    FROM dbo.Multi_Line_Rep_new WITH (UPDLOCK, HOLDLOCK) WHERE ID = @id;
    IF @matching_rows = 1
    BEGIN
      UPDATE dbo.Multi_Line_Rep_new
      SET ${EDITABLE_COLUMNS.map((c) => `${SQL_COLUMNS[c]} = @value_${c}`).join(', ')}
      WHERE ID = @id;
      SET @changed = @@ROWCOUNT;
    END;
    COMMIT TRANSACTION;
    SELECT @matching_rows AS matching_rows, @changed AS changed;`,
    params);

  if (result[0].changed === 0) {
    return reply(404, { error: 'This row changed or was deleted. Refresh and try again.' });
  }
  return reply(200, { saved: true });
});

endpoint('add', 'POST', async (request) => {
  const body = await request.json().catch(() => ({}));
  const values = {};
  for (const column of EDITABLE_COLUMNS) {
    const value = body[column] ?? '';
    if (typeof value !== 'string') {
      return reply(400, { error: `Value for ${column} must be text.` });
    }
    if (value.length > 100) {
      return reply(400, { error: `${column} must be 100 characters or fewer.` });
    }
    values[column] = value === '' ? null : value;
  }
  if (EDITABLE_COLUMNS.every((column) => values[column] === null)) {
    return reply(400, { error: 'Fill in at least one data field.' });
  }

  await run(`
    INSERT INTO dbo.Multi_Line_Rep_new
      (RAW_MULTI_LINE_REP, MULTI_LINE_REP, MLR_TEAM, MLR_SUBSIDIARY)
    VALUES
      (@raw_multi_line_rep, @multi_line_rep, @mlr_team, @mlr_subsidiary);`,
    values);
  return reply(201, { added: true });
});

endpoint('delete', 'POST', async (request) => {
  const body = await request.json().catch(() => ({}));
  const id = String(body.id ?? '').trim();
  if (!/^\d+$/.test(id)) return reply(400, { error: 'A valid row ID is required.' });
  if (BigInt(id) > 9223372036854775807n) return reply(400, { error: 'ID is outside the supported range.' });
  const params = { id };

  const result = await run(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @matching_rows bigint;
    DECLARE @deleted int = 0;
    SELECT @matching_rows = COUNT_BIG(*)
    FROM dbo.Multi_Line_Rep_new WITH (UPDLOCK, HOLDLOCK) WHERE ID = @id;
    IF @matching_rows = 1
    BEGIN
      DELETE FROM dbo.Multi_Line_Rep_new WHERE ID = @id;
      SET @deleted = @@ROWCOUNT;
    END;
    COMMIT TRANSACTION;
    SELECT @matching_rows AS matching_rows, @deleted AS deleted;`,
    params);

  if (result[0].deleted === 0) {
    return reply(404, { error: 'This row changed or was deleted. Refresh and try again.' });
  }
  return reply(200, { deleted: true });
});

endpoint('upload', 'POST', commitUploadedFiles);
