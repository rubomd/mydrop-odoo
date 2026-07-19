// netlify/functions/oviedo-sheet.js
//
// Lee los ingresos MENSUALES de la tienda de Oviedo desde la pestaña
// "RESUMEN GENERAL" de la hoja "Admin Mes - MD Oviedo".
//
// Estructura real de la pestaña (fila 13 = cabecera):
//   Col B = mes, C = EFECTIVO, D = TARJETA, E = GOLVO (Glovo), F = TOTAL,
//   G = INCR. VENTA (%), H = MEDIA
// Más abajo (fila ~31) hay una tabla de beneficio estimado al 50% sobre ventas,
// con bloques "SIN MERCADERIA" (col B-E) y "CON MERCADERIA" (col G-J).
//
// IMPORTANTE: la hoja tiene que estar publicada a la web o compartida como
// "Cualquiera con el enlace puede ver" para que esto funcione sin credenciales.
//
// Solo da granularidad MENSUAL (no diaria) — para filtros de semana o rango
// personalizado, el frontend debe avisar de que Oviedo no está disponible a
// ese nivel de detalle.

const SHEET_ID = '17a6pSqzy7U8vLAIP7FT93YOZNQ7P8iVwMrnFAobpPBw';
const SHEET_TAB = 'RESUMEN GENERAL';

const MESES = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO','JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];

exports.handler = async () => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(SHEET_TAB)}`;
    const res = await fetch(url);
    const text = await res.text();

    if (!res.ok || text.trim().startsWith('<')) {
      throw new Error('No se pudo leer la hoja. Comprueba que esté publicada a la web o compartida como "Cualquiera con el enlace".');
    }

    const jsonStr = text.substring(text.indexOf('(') + 1, text.lastIndexOf(')'));
    const parsed = JSON.parse(jsonStr);
    const rows = parsed.table.rows;

    const months = []; // { month, monthIndex, efectivo, tarjeta, golvo, total, media, profitEstimateConMercaderia }
    const profitByMonth = {};

    for (const row of rows) {
      const cells = (row.c || []).map(c => (c ? c.v : null));
      const label = (cells[1] || '').toString().trim().toUpperCase();
      const monthIdx = MESES.indexOf(label);
      if (monthIdx === -1) continue;

      // Bloque de ingresos (EFECTIVO/TARJETA/GOLVO/TOTAL/MEDIA) — columnas C..H (índices 2..7)
      const efectivo = typeof cells[2] === 'number' ? cells[2] : null;
      const tarjeta = typeof cells[3] === 'number' ? cells[3] : null;
      const golvo = typeof cells[4] === 'number' ? cells[4] : null;
      const total = typeof cells[5] === 'number' ? cells[5] : null;
      const media = typeof cells[7] === 'number' ? cells[7] : null;

      if (total != null) {
        months.push({ month: label, monthIndex: monthIdx, efectivo, tarjeta, golvo, total, media });
      }

      // Bloque de beneficio estimado (más abajo en la hoja, misma columna de mes en B) —
      // "CON MERCADERIA" TOTAL está en la columna J (índice 9)
      const conMercaderiaTotal = typeof cells[9] === 'number' ? cells[9] : null;
      if (conMercaderiaTotal != null) {
        profitByMonth[label] = conMercaderiaTotal;
      }
    }

    months.forEach(m => {
      m.profitEstimateConMercaderia = profitByMonth[m.month] != null ? profitByMonth[m.month] : null;
    });

    return { statusCode: 200, headers, body: JSON.stringify({ data: months }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
