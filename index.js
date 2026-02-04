process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

require("dotenv").config();
const express = require("express");
const fetch = global.fetch || require("node-fetch");

const connectMongo = require("./db/mongo");
const Config = require("./models/Config");
const Stock = require("./models/Stock");
const Horario = require("./models/Horario");
const PedidoDesposte = require("./models/PedidoDesposte");
const PedidoRetiro = require("./models/PedidoRetiro");
const Cliente = require("./models/Cliente");

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

  const pedidos = await PedidoDesposte.find({ fecha: fechaISO });
  const horasOcupadas = pedidos.map(p => p.hora);
  const libres = horas.filter(h => !horasOcupadas.includes(h));

  return libres.length > 0;
}

// ======================
// 👉 PROCESADOR REAL DEL BOT
// ======================
async function processWebhook(body) {
  const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return;

  const from = message.from;

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

  // 🛑 BLOQUEO DE EVENTOS TARDÍOS / DUPLICADOS
  if (sessions[from]?.step === "finalizado") {
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

  let id = rawId.trim().toUpperCase();

  // ---- MAPEOS ----
  if (["CANT_1", "1 MEDIA RES", "UNA MEDIA RES"].includes(id)) id = "CANT_1";
  if (["CANT_2", "2 MEDIAS RESES", "DOS MEDIAS RESES"].includes(id)) id = "CANT_2";

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
    const nombre = rawId.trim();

    const cliente = await Cliente.create({
      telefono: from,
      nombre,
    });

    sessions[from] = {
      step: "menu",
      cliente,
    };

    await sendText(from, `¡Gracias *${nombre}*! 👍`);
    await sendMainMenu(from);
    return;
  }

  // ======================
  // 5️⃣ Quién retira (SIEMPRE)
  // ======================
  if (sessions[from]?.step === "pedir_quien_retira") {
    const nombreRetira = rawId.trim();

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
    sessions[from].step = "cantidad";
    await showCantidad(from);
    return;
  }

  if (id === "MENU_HORARIOS") {
    sessions[from].step = "ver_horarios";
    await showFechasDisponibles(from, { modo: "general" });
    return;
  }

  if (id === "MENU_SALIR" && sessions[from]?.step === "menu") {
    delete sessions[from];
    await sendText(from, "👋 Gracias por escribirnos. ¡Te esperamos!");
    return;
  }

  if (id === "VOLVER_MENU") {
    sessions[from] = { step: "menu" };
    await sendMainMenu(from);
    return;
  }

  // ======================
  // Cantidad
  // ======================
  // ======================
  // Cantidad
  // ======================
  if (id.startsWith("CANT_")) {
    sessions[from].cantidad = Number(id.replace("CANT_", ""));
    sessions[from].step = "tipo";

    // 🔑 TEXTO INTERMEDIO (CLAVE)
    //await sendText(from, "Perfecto 👍");

    await showTipoRetiro(from);
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

    if (sessions[from].tipoRetiro === "retiro") {
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
    // bloquear sesión brevemente
    sessions[from] = { step: "finalizado" };
    return;
  }

  if (id === "CANCELAR_PEDIDO") {
    sessions[from] = { step: "menu" };
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
      { id: "MENU_SALIR", title: "❌ Salir" },
    ],
  });
}

async function showCantidad(to) {
  await sendButtons(to, {
    body: "🥩 ¿Cuántas medias reses querés?",
    buttons: [
      { id: "CANT_1", title: "1 media res" },
      { id: "CANT_2", title: "2 medias reses" },
      { id: "VOLVER_MENU", title: "⬅️ Volver" },
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

  const pedidos = await PedidoDesposte.find({ fecha: fechaISO });
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
  const cantidad = Number(s?.cantidad || 1);
  const tipo = s?.tipoRetiro;
  const fecha = s?.fecha;
  const hora = s?.hora;

  const stock = await Stock.findOne();
  const precioUnitario = stock?.precio ?? 0;
  const precioTotal = precioUnitario * cantidad;

  const tipoTexto =
    tipo === "desposte" ? "👀 Presenciar" : "📦 Retirar";

  await sendButtons(to, {
    body:
      `✅ *Confirmá tu pedido*\n\n` +
      `👤 Cliente: *${sessions[to].cliente.nombre}*\n` +
      `📦 Retira: *${sessions[to].retira}*\n\n` +
      `🥩 Cantidad: *${cantidad}*\n` +
      `🔪 Modalidad: *${tipoTexto}*\n` +
      `📅 Día: *${labelFecha(fecha)}*\n` +
      `🕒 Hora: *${hora}*\n\n` +
      `💰 Total: *$${precioTotal}*\n\n` +
      `ℹ️ El pago se realiza al retirar.`,
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
  const cantidad = Number(s?.cantidad || 1);
  const tipoRetiro = s?.tipoRetiro;
  const fecha = s?.fecha;
  const hora = s?.hora || "12:00";

  const stock = await Stock.findOne();
  if (!stock) {
    await sendText(to, "❌ Error interno de stock.");
    return;
  }

  const precioUnitario = stock.precio;
  const precioTotal = precioUnitario * cantidad;

  if (tipoRetiro === "desposte") {
    // 🥩 TURNO DE DESPOSTE → bloquea horario
    try {
      await PedidoDesposte.create({
        telefono: to,
        nombreCliente: sessions[to].cliente.nombre,
        cantidad,
        fecha,
        hora,
        precioUnitario,
        precioTotal,
        retira: { nombre: sessions[to].retira },
      });
    } catch (e) {
      await sendText(
        to,
        "❌ Ese horario acaba de ser tomado por otro cliente. Elegí otro por favor."
      );
      await showHorasDisponibles(to, fecha);
      return;
    }
  } else {
    // 📦 RETIRO → NO bloquea horarios
    await PedidoRetiro.create({
      telefono: to,
      nombreCliente: sessions[to].cliente.nombre,
      cantidad,
      fecha,
      precioUnitario,
      precioTotal,
      retira: { nombre: sessions[to].retira },
    });
  }

  stock.disponible -= cantidad;
  await stock.save();

  await sendText(
    to,
    `✅ *Pedido reservado con éxito*\n\n` +
    `🥩 Cantidad: *${cantidad}*\n` +
    `🔪 Modalidad: *${tipoRetiro === "desposte" ? "👀 Presenciar desposte" : "📦 Retirar despostada"}*\n` +
    `📅 Día: *${labelFecha(fecha)}*\n` +
    `🕒 Hora: *${hora}*`
  );

  await sendMainMenu(to);
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
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Bot Canciani activo en puerto ${PORT}`);
});

app.get("/", (req, res) => {
  res.status(200).send("OK BOT CANCIANI ✅");
});


