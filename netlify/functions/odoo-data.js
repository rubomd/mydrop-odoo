// netlify/functions/odoo-data.js
//
// Proxy seguro hacia Odoo (my-drop-cbd-sl1.odoo.com) via JSON-RPC.
// Las credenciales viven SOLO como variables de entorno en Netlify
// (Site settings > Environment variables), nunca en el código ni en el cliente.
//
// Variables de entorno necesarias en Netlify:
//   ODOO_URL       -> https://my-drop-cbd-sl1.odoo.com
//   ODOO_DB        -> my-drop-cbd-sl1  (normalmente el mismo nombre que el subdominio)
//   ODOO_LOGIN     -> ruben@mydropcbd.com
//   ODOO_PASSWORD  -> tu contraseña o, mejor, una API key generada en Odoo
//
// Uso desde el dashboard: GET /.netlify/functions/odoo-data?type=stock
//                          GET /.netlify/functions/odoo-data?type=sales

const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_LOGIN = process.env.ODOO_LOGIN;
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

async function odooCall(model, method, args = [], kwargs = {}) {
  // 1. Autenticar y obtener uid
  const authRes = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        db: ODOO_DB,
        login: ODOO_LOGIN,
        password: ODOO_PASSWORD,
      },
    }),
  });
  const authData = await authRes.json();
  const cookie = authRes.headers.get('set-cookie');
  if (!authData.result || !authData.result.uid) {
    throw new Error('Fallo de autenticación en Odoo: ' + JSON.stringify(authData.error || authData));
  }

  // 2. Llamar al método del modelo usando la sesión autenticada
  const callRes = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        model,
        method,
        args,
        kwargs,
      },
    }),
  });
  const callData = await callRes.json();
  if (callData.error) {
    throw new Error('Error Odoo (' + model + '.' + method + '): ' + JSON.stringify(callData.error));
  }
  return callData.result;
}

async function getStock() {
  // Stock por producto (solo variantes con stock > 0 o negativo, para no traer catálogo entero)
  return odooCall(
    'stock.quant',
    'search_read',
    [[['location_id.usage', '=', 'internal']]],
    {
      fields: ['product_id', 'location_id', 'quantity', 'reserved_quantity'],
      limit: 500,
    }
  );
}

async function getSales() {
  // Pedidos de venta confirmados de los últimos 90 días
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return odooCall(
    'sale.order',
    'search_read',
    [[['state', 'in', ['sale', 'done']], ['date_order', '>=', since]]],
    {
      fields: ['name', 'date_order', 'amount_total', 'state', 'partner_id'],
      limit: 500,
      order: 'date_order desc',
    }
  );
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    if (!ODOO_URL || !ODOO_DB || !ODOO_LOGIN || !ODOO_PASSWORD) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: 'Faltan variables de entorno de Odoo en Netlify (ODOO_URL, ODOO_DB, ODOO_LOGIN, ODOO_PASSWORD).',
        }),
      };
    }

    const type = (event.queryStringParameters && event.queryStringParameters.type) || 'stock';
    let data;
    if (type === 'stock') data = await getStock();
    else if (type === 'sales') data = await getSales();
    else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'type debe ser "stock" o "sales"' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ type, data }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
