process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

require("dotenv").config();
const express = require("express");
const fetch = global.fetch || require("node-fetch");

const connectMongo = require("./db/mongo");
const Config = require("./models/Config");
const Stock = require("./models/Stock");
const Horario = require("./models/Horario");
const Cliente = require("./models/Cliente");
const generarQRPedido = require("./utils/generarQRPedido");
const Producto = require("./models/Producto");
const Pedido = require("./models/Pedido");

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const app = express();
app.use(express.json());

connectMongo();

// ======================
// CONFIG
// ======================
const DIAS_ADELANTE = Number(process.env.DIAS_ADELANTE || 21);

// 🧠 Sesiones en memoria
const sessions = {};
// ⏱️ Tiempo máximo de inactividad antes de “dormir” la sesión (ej: 10 min)
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

// ======================
// HELPERS FECHA/HORA
// ======================
const pad2 = (n) => String(n).padStart(2, "0");
const isoDate = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDaysISO = (iso, days) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return isoDate(dt);
};
function dateFromISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}
const todayISO = () => isoDate(new Date(new Date().setHours(12, 0, 0, 0)));
const nowHHMM = () => {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const isHoraFutura = (hhmm) => hhmm >= nowHHMM();
const dayNameES = (d) => ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"][d.getDay()];
const labelFecha = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
  return `${dayNameES(dt)} ${pad2(d)}/${pad2(m)}`;
};
const getInteractiveId = (message) => {
  if (message?.type !== "interactive") return null;
  return (
    message?.interactive?.list_reply?.id ||
    message?.interactive?.button_reply?.id ||
    null
  );
};

// ======================
// HELPERS TEXTO / VALIDACIONES
// ======================
function capitalizarNombre(texto) {
  return texto
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map(
      (p) => p.charAt(0).toUpperCase() + p.slice(1)
    )
    .join(" ");
}
function normalizarEmpresa(texto) {
  return texto.trim().toUpperCase();
}
function soloNumeros(texto) {
  return texto.replace(/\D/g, "");
}
function validarDNI(dni) {
  return /^\d{7,8}$/.test(dni);
}
function validarCUIT(cuit) {
  return /^\d{11}$/.test(cuit);
}

// ======================
// HELPERS FECHAS DINÁMICAS (NUEVO)
// ======================
function getFechasPermitidas() {
  const fechas = [];
  const hoy = new Date();

  // 🔑 fijamos hora segura (mediodía)
  hoy.setHours(12, 0, 0, 0);

  for (let i = 1; i <= DIAS_ADELANTE; i++) {
    const d = new Date(hoy);
    d.setDate(hoy.getDate() + i);

    const dia = d.getDay(); // 0=Dom, 1=Lun, ..., 6=Sáb

    // Lunes a sábado
    if (dia >= 1 && dia <= 6) {
      fechas.push({
        iso: isoDate(d),
        dia,
      });
    }
  }

  return fechas;
}
async function getFechasConHorario() {
  const fechas = getFechasPermitidas();
  const plantillas = await Horario.find();
  const diasDisponibles = plantillas.map(p => p.dia);

  return fechas.filter(f => diasDisponibles.includes(f.dia));
}
async function diaTieneDisponibilidad(fechaISO, modo) {
  const fecha = dateFromISO(fechaISO);
  const dia = fecha.getDay();

  const plantilla = await Horario.findOne({ dia });
  if (!plantilla) return false;

  // 👉 RETIRO: si existe el día, está disponible
  if (modo === "retiro") {
    return true;
  }

  // 👉 GENERAL: mostrar el día si existe la plantilla
  if (modo === "general") {
    return true;
  }

  // 👉 DESPOSTE: sí bloquea horarios
  let horas = plantilla.horas;

  const pedidos = await Pedido.find({
    fecha: fechaISO,
    tipoPedido: "TURNO",
  });
  const horasOcupadas = pedidos.map(p => p.hora);
  const libres = horas.filter(h => !horasOcupadas.includes(h));

  return libres.length > 0;
}

function calcularTipoPedido(items) {
  return items.some(i => i.requiereTurno)
    ? "TURNO"
    : "RETIRO_DIA";
}

// ======================
// 👉 PROCESADOR REAL DEL BOT
// ======================
async function processWebhook(body) {
  const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return;

  const from = message.from;

  const messageType = message.type;
  const isUserMessage = messageType === "text" || messageType === "interactive";

  // 🛑 Si estaba salido o finalizado, SOLO despertar si el usuario escribe
  if (
    sessions[from] &&
    (sessions[from].step === "salido" || sessions[from].step === "finalizado")
  ) {
    if (!isUserMessage) {
      // evento viejo / delivery / status
      return;
    }

    // 🔄 RESET TOTAL DE SESIÓN
    delete sessions[from];
  }

  // ⏱️ Timeout por inactividad: si pasó mucho tiempo, dormir sesión
  if (sessions[from]?.lastAction) {
    const inactiveMs = Date.now() - sessions[from].lastAction;

    if (inactiveMs > SESSION_TIMEOUT_MS) {
      sessions[from] = { step: "salido", lastAction: Date.now() };
      return;
    }
  }

  // 🔒 Estado bot
  const config = await Config.findOne();
  if (config?.botActivo === false) {
    await sendText(from, config.mensajeCerrado || "❌ No hay pedidos disponibles.");
    return;
  }

  // 🧠 Inicializar sesión
  if (!sessions[from]) {
    const cliente = await Cliente.findOne({ telefono: from });

    sessions[from] = {
      step: cliente ? "menu" : "pedir_nombre_cliente",
      cliente,
      lastAction: Date.now(),
    };

    if (!cliente) {
      await sendText(
        from,
        "👋 Antes de empezar, ¿podés decirme tu *nombre completo o empresa*?"
      );
      return;
    }

    await sendMainMenu(from);
    return;
  }

  // ======================
  // CAPTURA + NORMALIZACIÓN INPUT
  // ======================
  let rawId = null;

  if (message.type === "interactive") {
    rawId = getInteractiveId(message);
  } else if (message.type === "text") {
    rawId = message.text?.body;
  }

  if (!rawId) return;

  // ✅ Cada interacción válida refresca actividad
  if (sessions[from]) sessions[from].lastAction = Date.now();

  let id = rawId.trim().toUpperCase();

  // ---- MAPEOS ----
  if (id === "HACER PEDIDO") id = "MENU_PEDIR";
  if (id === "VER HORARIOS") id = "MENU_HORARIOS";
  if (id === "SALIR") id = "MENU_SALIR";

  if (id === "PRESENCIAR DESPOSTE") id = "TIPO_DESPOSTE";
  if (id === "RETIRAR DESPOSTADA") id = "TIPO_RETIRO";

  console.log("📩 INPUT NORMALIZADO:", id);

  // ======================
  // 3️⃣ Nombre del cliente (PRIMERA VEZ)
  // ======================
  if (sessions[from]?.step === "pedir_nombre_cliente") {
    const texto = rawId.trim();

    sessions[from].nombreRaw = texto;
    sessions[from].step = "pedir_documento";

    await sendText(
      from,
      "🧾 ¿Podés indicarme tu *DNI* o *CUIT/CUIL*?\n\n" +
      "• DNI: 7 u 8 números\n" +
      "• CUIT/CUIL: 11 números"
    );
    return;
  }

  if (sessions[from]?.step === "pedir_documento") {
    const doc = soloNumeros(rawId);

    if (!validarDNI(doc) && !validarCUIT(doc)) {
      await sendText(
        from,
        "❌ Documento inválido.\n" +
        "• DNI: 7 u 8 números\n" +
        "• CUIT/CUIL: 11 números\n\n" +
        "Intentá nuevamente."
      );
      return;
    }

    const nombreRaw = sessions[from].nombreRaw;

    const esEmpresa = validarCUIT(doc);
    const nombreFinal = esEmpresa
      ? normalizarEmpresa(nombreRaw)
      : capitalizarNombre(nombreRaw);

    const cliente = await Cliente.create({
      telefono: from,
      nombre: nombreFinal,
      documento: doc,
      tipoDocumento: esEmpresa ? "CUIT" : "DNI",
    });

    sessions[from] = {
      step: "menu",
      cliente,
      lastAction: Date.now(),
    };

    await sendText(from, `¡Gracias *${nombreFinal}*! 👍`);
    await sendMainMenu(from);
    return;
  }

  // ======================
  // 5️⃣ Quién retira (SIEMPRE)
  // ======================
  if (sessions[from]?.step === "pedir_quien_retira") {
    const nombreRetira = capitalizarNombre(rawId.trim());
    sessions[from].retira = nombreRetira;
    sessions[from].step = "esperando_confirmacion";

    await Cliente.findOneAndUpdate(
      { telefono: from },
      { ultimoRetira: nombreRetira }
    );

    await showConfirmacion(from);
    return;
  }

  // ======================
  // ROUTER
  // ======================
  if (id === "MENU_PEDIR") {
    sessions[from].items = [];
    sessions[from].step = "productos";
    await showProductos(from);
    return;
  }

  if (id === "MENU_HORARIOS") {
    sessions[from].step = "ver_horarios";
    await showFechasDisponibles(from, { modo: "general" });
    return;
  }

  if (id === "MENU_SALIR") {
    sessions[from] = { step: "salido", lastAction: Date.now() };
    await sendText(from, "👋 Gracias por escribirnos. ¡Te esperamos!");
    return;
  }

  if (id === "VOLVER_MENU") {
    sessions[from] = {
      ...(sessions[from] || {}),
      step: "menu",
      lastAction: Date.now(),
    };
    await sendMainMenu(from);
    return;
  }

  if (id.startsWith("PROD_")) {
    const productoId = id.replace("PROD_", "");
    const producto = await Producto.findById(productoId);

    if (!producto || !producto.activo) {
      await sendText(from, "❌ Producto no disponible.");
      return;
    }

    const existente = sessions[from].items.find(
      i => i.productoId.toString() === producto._id.toString()
    );

    if (existente) {
      existente.cantidad += 1;
    } else {
      sessions[from].items.push({
        productoId: producto._id,
        nombre: producto.nombre,
        cantidad: 1,
        precioKg: producto.precioKg,
        requiereTurno: producto.requiereTurno,
      });
    }

    await sendText(from, `➕ *${producto.nombre}* agregado`);
    await showProductos(from);
    return;
  }

  if (id === "FIN_PRODUCTOS") {
    if (!sessions[from].items.length) {
      await sendText(from, "❌ Tenés que elegir al menos un producto.");
      return;
    }

    const tipoPedido = calcularTipoPedido(sessions[from].items);
    sessions[from].tipoPedido = tipoPedido;
    sessions[from].step = "fecha";

    if (tipoPedido === "TURNO") {
      await showFechasDisponibles(from, { modo: "desposte" });
    } else {
      await showFechasDisponibles(from, { modo: "retiro" });
    }

    return;
  }

  // ======================
  // Tipo retiro
  // ======================
  if (id === "TIPO_DESPOSTE" || id === "TIPO_RETIRO") {
    sessions[from].tipoRetiro = id === "TIPO_DESPOSTE" ? "desposte" : "retiro";
    sessions[from].step = "fecha";
    await showFechasDisponibles(from, {
      modo: sessions[from].tipoRetiro,
    });
    return;
  }

  // ======================
  // Fecha
  // ======================
  if (id.startsWith("FECHA_")) {
    const fecha = id.replace("FECHA_", "");
    sessions[from].fecha = fecha;

    if (sessions[from].tipoPedido === "RETIRO_DIA") {
      sessions[from].hora = "12:00";
      sessions[from].step = "pedir_quien_retira";
      await sendText(from, "👤 ¿Quién va a retirar el pedido?");
    } else {
      await showHorasDisponibles(from, fecha);
    }
    return;
  }

  // ======================
  // Hora
  // ======================
  if (id.startsWith("HORA_")) {
    sessions[from].hora = id.replace("HORA_", "");
    sessions[from].step = "pedir_quien_retira";
    await sendText(from, "👤 ¿Quién va a retirar el pedido?");
    return;
  }

  // ======================
  // Confirmar
  // ======================
  if (id === "CONFIRMAR_PEDIDO") {
    await finalizarPedido(from);
    sessions[from] = {
      step: "finalizado",
      lastAction: Date.now(),
    };
    return;
  }

  if (id === "CANCELAR_PEDIDO") {
    sessions[from] = {
      ...(sessions[from] || {}),
      step: "menu",
      lastAction: Date.now(),
    };
    await sendMainMenu(from);
    return;
  }

  // Fallback
  await sendText(from, "❌ No entendí la opción.");
  await sendMainMenu(from);
}

// ======================
// MENÚS Y FLUJO
// ======================
async function sendMainMenu(to) {
  await sendButtons(to, {
    body: "👋 Bienvenido a *CANCIANI CARNES*",
    buttons: [
      { id: "MENU_PEDIR", title: "🥩 Hacer pedido" },
      //{ id: "MENU_HORARIOS", title: "🕒 Ver horarios" },
      //{ id: "MENU_SALIR", title: "❌ Salir" },
    ],
  });
}

async function showTipoRetiro(to) {
  await sendList(to, {
    body: "🔪 ¿Cómo querés recibir la media res?",
    buttonText: "Elegir opción",
    sectionTitle: "Modalidad",
    rows: [
      {
        id: "TIPO_DESPOSTE",
        title: "Presenciar el desposte",
        description: "Ver el proceso en el momento",
      },
      {
        id: "TIPO_RETIRO",
        title: "Retirar despostada",
        description: "Lista para retirar a las 12:00",
      },
    ],
  });
}

// ======================
// Mostrar FECHAS disponibles (próximos N días)
// modo:
//  - "desposte": necesita turnos disponibles para (08..12)
//  - "retiro": necesita turno 12:00 disponible
//  - "general": muestra días con cualquier turno disponible
// ======================
async function showFechasDisponibles(to, { modo }) {
  const fechas = await getFechasConHorario();

  const disponibles = [];

  for (const f of fechas) {
    const ok = await diaTieneDisponibilidad(f.iso, modo);
    if (ok) disponibles.push(f.iso);
  }

  const rows = disponibles.slice(0, 8).map(f => ({
    id: `FECHA_${f}`,
    title: labelFecha(f),
    description: "Disponible",
  }));

  rows.push(
    {
      id: "VOLVER_MENU",
      title: "⬅️ Volver al menú",
      description: "",
    },
    {
      id: "MENU_SALIR",
      title: "❌ Cancelar",
      description: "",
    }
  );

  const titulo =
    modo === "retiro"
      ? "📅 Elegí el día (retiro a las 12:00)"
      : modo === "desposte"
        ? "📅 Elegí el día para presenciar el desposte"
        : "📅 Fechas con turnos disponibles";

  await sendList(to, {
    body: titulo,
    buttonText: "Ver fechas",
    sectionTitle: "Fechas",
    rows,
  });
}

// ======================
// Mostrar HORAS disponibles (para una fecha)
// ======================
async function showHorasDisponibles(to, fechaISO) {
  const fecha = dateFromISO(fechaISO);
  const dia = fecha.getDay();

  const plantilla = await Horario.findOne({ dia });
  if (!plantilla) {
    await sendText(to, "❌ No hay horarios para ese día.");
    await sendBackButton(to);
    return;
  }

  let horas = plantilla.horas;

  // si es hoy, no mostrar horas pasadas
  if (fechaISO === todayISO()) {
    horas = horas.filter(h => isHoraFutura(h));
  }

  const pedidos = await Pedido.find({
    fecha: fechaISO,
    tipoPedido: "TURNO",
  });
  const ocupadas = pedidos.map(p => p.hora);
  const libres = horas.filter(h => !ocupadas.includes(h));

  if (!libres.length) {
    await sendText(to, "❌ No hay horarios disponibles para ese día.");
    await sendBackButton(to);
    return;
  }

  const rows = libres.slice(0, 10).map(h => ({
    id: `HORA_${h}`,
    title: h,
    description: "Disponible",
  }));

  await sendList(to, {
    body: `🕒 Horarios disponibles para *${labelFecha(fechaISO)}*`,
    buttonText: "Ver horarios",
    sectionTitle: "Horarios",
    rows,
  });

}

// ======================
// Confirmación
// ======================
async function showConfirmacion(to) {
  const s = sessions[to];
  const tipoPedido = s?.tipoPedido;
  const fecha = s?.fecha;
  const hora = s?.hora;
  const tipoTexto =
    tipoPedido === "TURNO"
      ? "👀 Presenciar desposte"
      : "📦 Retiro (08:00 a 12:00)";

  await sendButtons(to, {
    body:
      `✅ *Confirmá tu pedido*\n\n` +
      `👤 Cliente: *${sessions[to].cliente.nombre}*\n` +
      `📦 Retira: *${sessions[to].retira}*\n\n` +
      `🔪 Modalidad: *${tipoTexto}*\n` +
      `📅 Día: *${labelFecha(fecha)}*\n` +
      `🕒 Hora: *${hora}*\n\n`,
    buttons: [
      { id: "CONFIRMAR_PEDIDO", title: "✅ Confirmar" },
      { id: "CANCELAR_PEDIDO", title: "❌ Cancelar" },
      { id: "VOLVER_MENU", title: "⬅️ Menú" },
    ],
  });
}

// ======================
// Finalizar pedido (reserva turno + descuenta stock + guarda pedido)
// ======================
async function finalizarPedido(to) {
  const s = sessions[to];
  const fecha = s?.fecha;
  const hora = s?.hora || "12:00";

  const items = sessions[to].items;
  const tipoPedido = sessions[to].tipoPedido;

  // ✅ 3) Validaciones de turno/hora
  if (tipoPedido === "TURNO") {
    if (!hora) {
      await sendText(to, "❌ Falta hora para un pedido con turno.");
      return;
    }
  }

  // ✅ 4) Chequear y descontar stock por UNIDADES (no kilos)
  // (si mañana agregás costillar/salamín, se descuenta cada uno)
  for (const it of items) {
    const p = await Producto.findById(it.productoId);
    if (!p || !p.activo) {
      await sendText(to, `❌ Producto no disponible: ${it.nombre}`);
      return;
    }
    if (p.stock < it.cantidad) {
      await sendText(to, `❌ No hay stock suficiente de ${p.nombre}.`);
      return;
    }
  }

  // ✅ 5) Crear pedido v2
  let pedido;
  try {
    pedido = await Pedido.create({
      telefono: to,
      nombreCliente: sessions[to].cliente.nombre,
      retira: { nombre: sessions[to].retira },

      fecha,
      hora: tipoPedido === "TURNO" ? hora : undefined,

      tipoPedido,
      items,

      estado: "RESERVADO",
    });
  } catch (e) {
    // si chocó el índice único de TURNO
    if (tipoPedido === "TURNO") {
      await sendText(
        to,
        "❌ Ese horario acaba de ser tomado por otro cliente. Elegí otro por favor."
      );
      await showHorasDisponibles(to, fecha);
      return;
    }
    console.error(e);
    await sendText(to, "❌ Error interno creando el pedido.");
    return;
  }

  // ✅ 6) Descontar stock (unidades)
  for (const it of items) {
    await Producto.findByIdAndUpdate(it.productoId, { $inc: { stock: -it.cantidad } });
  }

  const tipoTexto =
    tipoPedido === "TURNO"
      ? "👀 Presenciar desposte"
      : "📦 Retiro (08:00 a 12:00)";

  await sendText(
    to,
    `✅ *Pedido reservado con éxito*\n\n` +
    `👤 Cliente: *${sessions[to].cliente.nombre}*\n` +
    `📦 Retira: *${sessions[to].retira}*\n\n` +
    `🧾 Productos:\n` +
    items.map(i => `• ${i.nombre} x${i.cantidad}`).join("\n") +
    `\n\n📅 Día: *${labelFecha(fecha)}*\n` +
    (tipoPedido === "TURNO" ? `🕒 Turno: *${hora}*\n` : `🕒 Retiro: *08:00 a 12:00*\n`) +
    `\n💬 *El precio final se calcula al retirar según los kilos reales.*`
  );

  // ✅ 8) QR (igual que antes, pero ahora apunta al Pedido v2)
  await wabaFetch({
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: {
      link: `https://canciani-whatsapp-bot-production.up.railway.app/qr/${pedido._id}`,
    },
  });

  await sendText(
    to,
    "📦 Este es tu *QR de retiro*.\n\n📍 Presentalo cuando vengas a retirar tu pedido."
  );
}

async function wabaFetch(payload) {
  const res = await fetch("https://waba-v2.360dialog.io/messages", {
    method: "POST",
    headers: {
      "D360-API-KEY": process.env.WHATSAPP_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();

  if (!res.ok) {
    console.error("❌ WABA ERROR:", res.status, text);
    throw new Error("WABA SEND FAILED");
  }

  return text;
}

// ======================
// UTILIDADES ENVÍO
// ======================
async function sendText(to, body) {
  return wabaFetch({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
}

async function sendButtons(to, { body, buttons }) {
  return wabaFetch({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  });
}

async function sendList(to, { body, buttonText, sectionTitle, rows, footer }) {
  return wabaFetch({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: body },
      footer: footer ? { text: footer } : undefined,
      action: {
        button: buttonText || "Ver opciones",
        sections: [
          {
            title: sectionTitle || "Opciones",
            rows,
          },
        ],
      },
    },
  });
}

async function sendBackButton(to) {
  await sendButtons(to, {
    body: "Elige una opción",
    buttons: [{ id: "VOLVER_MENU", title: "⬅️ Volver al menú" }, { id: "MENU_SALIR", title: "❌ Salir" }],
  });
}

async function showProductos(to) {
  const productos = await Producto.find({ activo: true });

  const rows = productos.map((p) => ({
    id: `PROD_${p._id}`,
    title: p.nombre,
    description: p.requiereTurno ? "Requiere turno" : "Retiro en el día",
  }));

  rows.push({
    id: "FIN_PRODUCTOS",
    title: "✅ Continuar",
    description: "Seguir con el pedido",
  });

  await sendList(to, {
    body: "🥩 Elegí los productos (podés seleccionar varios)",
    buttonText: "Ver productos",
    sectionTitle: "Productos",
    rows,
  });
}

// ======================
// 👉 WEBHOOK VERIFICATION (OBLIGATORIO)
// ======================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token === process.env.WEBHOOK_VERIFY_TOKEN
  ) {
    console.log("✅ Webhook verificado correctamente");
    return res.status(200).send(challenge);
  }

  console.log("❌ Falló verificación webhook");
  return res.sendStatus(403);
});

// ======================
// 👉 WEBHOOK (RESPUESTA INMEDIATA)
// ======================
app.post("/webhook", (req, res) => {
  // WhatsApp necesita el OK YA
  res.send("OK");

  // Procesar el mensaje en segundo plano
  processWebhook(req.body).catch(console.error);
});

// ======================
// 👉 NOTIFICACIÓN DESDE ADMIN (NUEVO)
// ======================
app.post("/notify-entrega", async (req, res) => {
  const { telefono, mensaje } = req.body;

  if (!telefono || !mensaje) {
    return res.status(400).json({ error: "Datos incompletos" });
  }

  try {
    await sendText(telefono, mensaje);
    res.json({ ok: true });
  } catch (e) {
    console.error("❌ Error enviando WhatsApp:", e);
    res.status(500).json({ error: "Error enviando WhatsApp" });
  }
});

// ======================
// 📸 GENERAR QR DEL PEDIDO
// ======================
app.get("/qr/:pedidoId", async (req, res) => {
  try {
    const { pedidoId } = req.params;

    const pedido = await Pedido.findById(pedidoId);

    if (!pedido) {
      return res.status(404).send("Pedido no encontrado");
    }

    const bufferQR = await generarQRPedido({
      pedidoId: pedido._id.toString(),
      fecha: pedido.fecha,
      hora: pedido.hora || "12:00",
      telefono: pedido.telefono,
    });

    res.setHeader("Content-Type", "image/png");
    res.send(bufferQR);
  } catch (error) {
    console.error("❌ Error generando QR:", error);
    res.status(500).send("Error generando QR");
  }
});

// ======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Bot Canciani activo en puerto ${PORT}`);
});

app.get("/", (req, res) => {
  res.status(200).send("OK BOT CANCIANI ✅");
});

// ======================
// 🔍 ADMIN - VER PEDIDO POR QR
// ======================
app.get("/admin/pedidos/:id", async (req, res) => {
  const pedido = await Pedido.findById(req.params.id)
    .populate("items.productoId");

  if (!pedido) {
    return res.status(404).json({ error: "Pedido no encontrado" });
  }

  res.json(pedido);
});

// ======================
// ✅ ADMIN - CERRAR PEDIDO POR QR
// ======================
app.post("/admin/pedidos/:id/cerrar", async (req, res) => {
  const { items } = req.body;
  // items = [{ productoId, kilos }]

  const pedido = await Pedido.findById(req.params.id);
  if (!pedido) {
    return res.status(404).json({ error: "Pedido no encontrado" });
  }

  let total = 0;

  pedido.items = pedido.items.map(item => {
    const data = items.find(
      i => i.productoId === item.productoId.toString()
    );

    const kilos = Number(data?.kilos || 0);
    const subtotal = kilos * item.precioKg;

    total += subtotal;

    return {
      ...item.toObject(),
      kilosReales: kilos,
      subtotal,
    };
  });

  pedido.precioFinal = total;
  pedido.estado = "ENTREGADO";

  await pedido.save();

  // 📲 WhatsApp final
  await sendText(
    pedido.telefono,
    `✅ *Pedido entregado*\n\n` +
    pedido.items
      .map(i => `• ${i.nombre}: ${i.kilosReales} kg → $${i.subtotal}`)
      .join("\n") +
    `\n\n💰 Total: *$${pedido.precioFinal}*\n\n¡Gracias por tu compra! 🥩`
  );

  res.json({ ok: true, total });
});

