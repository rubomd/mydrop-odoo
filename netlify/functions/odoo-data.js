// netlify/functions/odoo-data.js
//
// Proxy seguro hacia Odoo (my-drop-cbd-sl1.odoo.com) via JSON-RPC.
// Credenciales SOLO en variables de entorno de Netlify.
//
// Endpoints:
//   GET /.netlify/functions/odoo-data?type=stock   -> stock + alertas de seguridad
//   GET /.netlify/functions/odoo-data?type=sales   -> ventas por canal + rentabilidad por canal y producto
//   GET /.netlify/functions/odoo-data?type=diag    -> diagnóstico (equipos, almacenes, etc.)

const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_LOGIN = process.env.ODOO_LOGIN;
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

async function odooCall(model, method, args = [], kwargs = {}) {
  const authRes = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { db: ODOO_DB, login: ODOO_LOGIN, password: ODOO_PASSWORD },
    }),
  });
  const authData = await authRes.json();
  const cookie = authRes.headers.get('set-cookie');
  if (!authData.result || !authData.result.uid) {
    throw new Error('Fallo de autenticación en Odoo: ' + JSON.stringify(authData.error || authData));
  }

  const callRes = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: { model, method, args, kwargs },
    }),
  });
  const callData = await callRes.json();
  if (callData.error) {
    throw new Error('Error Odoo (' + model + '.' + method + '): ' + JSON.stringify(callData.error));
  }
  return callData.result;
}

// --- Clasificación de canal / línea de negocio ---
function classifyChannel(order) {
  const partnerName = (order.partner_id ? order.partner_id[1] : '').toLowerCase();
  const teamName = order.team_id ? order.team_id[1] : '';

  if (partnerName.includes('avil')) return 'Franquicia Avilés';
  if (partnerName.includes('gij')) return 'Franquicia Gijón';
  if (teamName === 'Website') return 'Tienda Online';
  if (teamName === 'Point of Sale') return 'Tienda Oviedo';
  return 'B2B';
}

// --- Stock con alertas de seguridad ---
async function getStockData() {
  const quants = await odooCall(
    'stock.quant',
    'search_read',
    [[['location_id.usage', '=', 'internal']]],
    { fields: ['product_id', 'location_id', 'quantity', 'reserved_quantity'], limit: 1000 }
  );

  const productIds = [...new Set(quants.map(q => (q.product_id ? q.product_id[0] : null)).filter(Boolean))];

  let orderpoints = [];
  if (productIds.length) {
    orderpoints = await odooCall(
      'stock.warehouse.orderpoint',
      'search_read',
      [[['product_id', 'in', productIds]]],
      { fields: ['product_id', 'product_min_qty', 'product_max_qty', 'warehouse_id'] }
    ).catch(() => []);
  }

  const minByProduct = {};
  orderpoints.forEach(op => {
    if (op.product_id) minByProduct[op.product_id[0]] = op.product_min_qty;
  });

  const DEFAULT_MIN = 5; // umbral de seguridad si el producto no tiene regla de reposición configurada en Odoo

  const rows = quants.map(q => {
    const pid = q.product_id ? q.product_id[0] : null;
    const hasRule = pid != null && minByProduct[pid] != null;
    const minQty = hasRule ? minByProduct[pid] : DEFAULT_MIN;
    return {
      product_id: q.product_id,
      location_id: q.location_id,
      quantity: q.quantity,
      reserved_quantity: q.reserved_quantity,
      minQty,
      hasRule,
      alert: q.quantity <= minQty,
    };
  });

  return rows;
}

// --- Ventas por canal + rentabilidad por canal y producto ---
async function getSalesData() {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const orders = await odooCall(
    'sale.order',
    'search_read',
    [[['state', 'in', ['sale', 'done']], ['date_order', '>=', since]]],
    { fields: ['name', 'date_order', 'amount_total', 'state', 'partner_id', 'team_id'], limit: 1000, order: 'date_order desc' }
  );

  const orderIds = orders.map(o => o.id);
  let lines = [];
  if (orderIds.length) {
    lines = await odooCall(
      'sale.order.line',
      'search_read',
      [[['order_id', 'in', orderIds]]],
      { fields: ['product_id', 'price_subtotal', 'product_uom_qty', 'order_id'], limit: 8000 }
    );
  }

  const productIds = [...new Set(lines.map(l => (l.product_id ? l.product_id[0] : null)).filter(Boolean))];
  let costs = {};
  if (productIds.length) {
    const products = await odooCall('product.product', 'read', [productIds], { fields: ['standard_price'] });
    products.forEach(p => { costs[p.id] = p.standard_price || 0; });
  }

  const channelByOrderId = {};
  orders.forEach(o => { channelByOrderId[o.id] = classifyChannel(o); });

  // Agregado por canal
  const channelAgg = {};
  orders.forEach(o => {
    const ch = channelByOrderId[o.id];
    if (!channelAgg[ch]) channelAgg[ch] = { channel: ch, orders: 0, revenue: 0, cost: 0 };
    channelAgg[ch].orders += 1;
    channelAgg[ch].revenue += o.amount_total || 0;
  });
  lines.forEach(l => {
    const oid = l.order_id ? l.order_id[0] : null;
    const ch = channelByOrderId[oid];
    if (!ch) return;
    const pid = l.product_id ? l.product_id[0] : null;
    channelAgg[ch].cost += (costs[pid] || 0) * (l.product_uom_qty || 0);
  });
  const channels = Object.values(channelAgg).map(c => ({
    ...c,
    margin: c.revenue - c.cost,
    marginPct: c.revenue ? ((c.revenue - c.cost) / c.revenue) * 100 : 0,
  })).sort((a, b) => b.revenue - a.revenue);

  // Agregado por producto
  const productAgg = {};
  lines.forEach(l => {
    const pid = l.product_id ? l.product_id[0] : 'unknown';
    const pname = l.product_id ? l.product_id[1] : 'Desconocido';
    if (!productAgg[pid]) productAgg[pid] = { product: pname, qty: 0, revenue: 0, cost: 0 };
    productAgg[pid].qty += l.product_uom_qty || 0;
    productAgg[pid].revenue += l.price_subtotal || 0;
    productAgg[pid].cost += (costs[pid] || 0) * (l.product_uom_qty || 0);
  });
  const products = Object.values(productAgg).map(p => ({
    ...p,
    margin: p.revenue - p.cost,
    marginPct: p.revenue ? ((p.revenue - p.cost) / p.revenue) * 100 : 0,
  })).sort((a, b) => b.revenue - a.revenue);

  const ordersOut = orders.map(o => ({ ...o, channel: channelByOrderId[o.id] }));

  return { channels, products, orders: ordersOut };
}

async function getDiagnostics() {
  const [teams, warehouses, posConfigs, orderFields, sampleOrders] = await Promise.all([
    odooCall('crm.team', 'search_read', [[]], { fields: ['id', 'name'] }).catch(e => ({ error: e.message })),
    odooCall('stock.warehouse', 'search_read', [[]], { fields: ['id', 'name', 'code'] }).catch(e => ({ error: e.message })),
    odooCall('pos.config', 'search_read', [[]], { fields: ['id', 'name'] }).catch(e => ({ error: e.message })),
    odooCall('ir.model.fields', 'search_read', [[['model', '=', 'sale.order'], ['name', 'like', 'x_']]], { fields: ['name', 'field_description', 'ttype'] }).catch(e => ({ error: e.message })),
    odooCall('sale.order', 'search_read', [[]], { fields: ['name', 'team_id', 'partner_id'], limit: 8, order: 'date_order desc' }).catch(e => ({ error: e.message })),
  ]);
  return { teams, warehouses, posConfigs, customFieldsOnOrders: orderFields, sampleOrders };
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
        body: JSON.stringify({ error: 'Faltan variables de entorno de Odoo en Netlify.' }),
      };
    }

    const type = (event.queryStringParameters && event.queryStringParameters.type) || 'stock';
    let data;
    if (type === 'stock') data = await getStockData();
    else if (type === 'sales') data = await getSalesData();
    else if (type === 'diag') data = await getDiagnostics();
    else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'type debe ser "stock", "sales" o "diag"' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ type, data }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
