process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

require("dotenv").config();
const express = require("express");
//const fetch = global.fetch || require("node-fetch");

const connectMongo = require("./db/mongo");
const Config = require("./models/Config");
const Horario = require("./models/Horario");
const Cliente = require("./models/Cliente");
const generarQRPedido = require("./utils/generarQRPedido");
const Producto = require("./models/Producto");
const Pedido = require("./models/Pedido");

const app = express();
app.use(express.json());

connectMongo();

const redis = require("./lib/redis");

const sessionKey = (phone) => `session:${phone}`;

async function getSession(phone) {
  const data = await redis.get(sessionKey(phone));
  return data ? JSON.parse(data) : null;
}

async function setSession(phone, value) {
  await redis.set(
    sessionKey(phone),
    JSON.stringify(value),
    "EX",
    60 * 15 // 15 minutos
  );
}

async function deleteSession(phone) {
  await redis.del(sessionKey(phone));
}

// ======================
// CONFIG
// ======================
const DIAS_ADELANTE = Number(process.env.DIAS_ADELANTE || 21);

// ⏱️ Tiempo máximo de inactividad antes de “dormir” la sesión (ej: 10 min)
const SESSION_WARNING_MS = 5 * 60 * 1000; // “¿seguís ahí?”
const SESSION_TIMEOUT_MS = 8 * 60 * 1000; // reset total

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

// ======================
// 👉 PROCESADOR REAL DEL BOT
// ======================
async function processWebhook(body) {
  const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return;

  const from = message.from;

  // 🛑 Si estaba salido o finalizado, SOLO despertar si el usuario escribe
  let session = await getSession(from);

  if (session) {
    const idle = Date.now() - session.lastAction;

    // ⚠️ Aviso previo
    if (!session.warned && idle > SESSION_WARNING_MS) {
      session.warned = true;
      await setSession(from, session);
      await sendText(from, "⏰ ¿Seguís ahí?");
      return;
    }

    // ⌛ Timeout total
    if (idle > SESSION_TIMEOUT_MS) {
      await deleteSession(from);
      await sendText(
        from,
        "⌛ La sesión expiró por inactividad.\nEscribí nuevamente para empezar."
      );
      return;
    }
  }

  if (!session) {
    const cliente = await Cliente.findOne({ telefono: from });
    session = {
      step: cliente ? "menu" : "pedir_nombre_cliente",
      cliente,
      items: [],
      lastAction: Date.now(),
      warned: false,
    };
    await setSession(from, session);

    if (!cliente) {
      await sendText(from, "👋 Antes de empezar, ¿podés decirme tu *nombre completo o empresa*?");
      return;
    }

    await sendMainMenu(from);
    return;
  }

  // 🔒 Estado bot
  const config = await Config.findOne();
  if (config?.botActivo === false) {
    await sendText(from, config.mensajeCerrado || "❌ No hay pedidos disponibles.");
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

  // ======================
  // 💤 Respuesta al "¿Seguís ahí?"
  // ======================
  if (session?.warned && message.type === "text") {
    session.warned = false;
    session.lastAction = Date.now();
    await setSession(from, session);

    await sendText(from, "👍 Perfecto, seguimos.");

    // 🔁 Reanudar flujo según step actual
    const step = session.step;

    if (step === "productos") {
      await showProductos(from);
      return;
    }

    if (step === "cantidad") {
      const prod = session.productoPendiente;
      if (prod) {
        await sendText(from, "🔢 Decime la cantidad que querés.");
      } else {
        session.step = "productos";
        await setSession(from, session);
        await showProductos(from);
      }
      return;
    }

    if (step === "menu") {
      await sendMainMenu(from);
      return;
    }

    if (step === "fecha") {
      await showFechasDisponibles(from, { modo: session.tipoRetiro });
      return;
    }

    if (step === "pedir_quien_retira") {
      await sendText(from, "👤 ¿Quién va a retirar el pedido?");
      return;
    }

    // fallback seguro
    await sendMainMenu(from);
    return;
  }

  // ✅ Cada interacción válida refresca actividad
  if (session) {
    session.warned = false;
    session.lastAction = Date.now();
    await setSession(from, session);
  }

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
  if (session.step === "pedir_nombre_cliente") {
    const texto = rawId.trim();

    session.nombreRaw = texto;
    session.step = "pedir_documento";
    await setSession(from, session);

    await sendText(
      from,
      "🧾 ¿Podés indicarme tu *DNI* o *CUIT/CUIL*?\n\n" +
      "• DNI: 7 u 8 números\n" +
      "• CUIT/CUIL: 11 números"
    );
    return;
  }

  if (session.step === "pedir_documento") {
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

    const nombreRaw = session.nombreRaw;

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

    session = {
      step: "menu",
      cliente,
      items: [],
      lastAction: Date.now(),
      warned: false,
    };

    await setSession(from, session);

    await sendText(from, `¡Gracias *${nombreFinal}*! 👍`);
    await sendMainMenu(from);
    return;
  }

  if (session.step === "quien_retira_opcion") {
    if (id === "RETIRA_ULTIMO") {
      const nombreRetira = session.cliente.ultimoRetira;
      session.retira = nombreRetira;
      session.step = "esperando_confirmacion";
      await setSession(from, session);
      await showConfirmacion(from);
      return;
    }

    if (id === "RETIRA_OTRO") {
      session.step = "pedir_quien_retira";
      await setSession(from, session);
      await sendText(from, "👤 Escribí el nombre de quien retira:");
      return;
    }
  }

  // ======================
  // 5️⃣ Quién retira (SIEMPRE)
  // ======================
  if (session.step === "pedir_quien_retira") {
    const nombreRetira = capitalizarNombre(rawId.trim());

    session.retira = nombreRetira;
    session.step = "esperando_confirmacion";

    await Cliente.findOneAndUpdate(
      { telefono: from },
      { ultimoRetira: nombreRetira }
    );

    await setSession(from, session);
    await showConfirmacion(from);
    return;
  }

  // ======================
  // ROUTER
  // ======================
  if (id === "MENU_PEDIR") {
    session.items = [];
    session.step = "productos";
    await setSession(from, session);
    await showProductos(from);
    return;
  }

  if (id === "MENU_HORARIOS") {
    session.step = "ver_horarios";
    await setSession(from, session);
    await showFechasDisponibles(from, { modo: "general" });
    return;
  }

  if (id === "MENU_SALIR") {
    session = { step: "salido", lastAction: Date.now() };
    await setSession(from, session);
    await sendText(from, "👋 Gracias por escribirnos. ¡Te esperamos!");
    return;
  }

  if (id === "VOLVER_MENU") {
    session.step = "menu";
    session.lastAction = Date.now();
    await setSession(from, session);
    await sendMainMenu(from);
    return;
  }

  if (id === "AGREGAR_MAS") {
    await showProductos(from);
    return;
  }

  if (id.startsWith("PROD_")) {
    const productoId = id.replace("PROD_", "");
    const producto = await Producto.findById(productoId);

    if (!producto || !producto.activo) {
      await sendText(from, "❌ Producto no disponible.");
      return;
    }

    // ✅ 5) Bloquear si no hay stock
    if ((producto.stock ?? 0) <= 0) {
      await sendText(from, `❌ *${producto.nombre}* está sin stock.`);
      await showProductos(from);
      return;
    }

    // Guardamos producto pendiente para pedir cantidad
    session.productoPendiente = {
      productoId: producto._id,
      nombre: producto.nombre,
      precioKg: producto.precioKg,
      requiereTurno: producto.requiereTurno,
    };

    session.step = "cantidad";
    await setSession(from, session);

    await sendButtons(from, {
      body: textoCantidad(producto),
      buttons: [
        { id: "CANT_1", title: "1" },
        { id: "CANT_2", title: "2" },
        { id: "CANT_3", title: "3" },
      ],
    });

    await sendText(from, "✍️ Si querés más de 3, escribí el número (solo números).");
    return;
  }

  if (id.startsWith("SINSTOCK_")) {
    await sendText(from, "❌ Ese producto está sin stock en este momento.");
    await showProductos(from);
    return;
  }

  // ======================
  // Cantidad de producto
  // ======================
  if (session.step === "cantidad") {
    let cantidad = null;

    if (id === "CANT_1") cantidad = 1;
    if (id === "CANT_2") cantidad = 2;
    if (id === "CANT_3") cantidad = 3;

    if (cantidad === null) {
      const n = Number(soloNumeros(rawId));
      if (!Number.isFinite(n) || n <= 0) {
        await sendText(from, "❌ Cantidad inválida. Escribí un número (ej: 4).");
        return;
      }
      cantidad = n;
    }

    const prod = session.productoPendiente;
    if (!prod) {
      await sendText(from, "❌ Error interno. Volvamos a empezar.");
      session.step = "productos";
      await setSession(from, session);
      await showProductos(from);
      return;
    }

    const productoDB = await Producto.findById(prod.productoId);
    if (!productoDB || !productoDB.activo || productoDB.stock < cantidad) {
      await sendText(from, `❌ No hay stock suficiente de *${prod.nombre}*.`);
      session.productoPendiente = null;
      session.step = "productos";
      await setSession(from, session);
      await showProductos(from);
      return;
    }

    const existente = session.items.find(
      i => i.productoId.toString() === prod.productoId.toString()
    );

    if (existente) {
      existente.cantidad += cantidad;
    } else {
      session.items.push({
        productoId: prod.productoId,
        nombre: productoDB.nombre,
        nombrePlural: productoDB.nombrePlural,
        genero: productoDB.genero,
        cantidad,
        precioKg: prod.precioKg,
        requiereTurno: prod.requiereTurno,
      });
    }

    session.productoPendiente = null;
    session.step = "productos";
    await setSession(from, session);

    const nombreItem = nombrePorCantidad(productoDB, cantidad);

    const item = session.items.find(
      i => i.productoId.toString() === prod.productoId.toString()
    );

    await sendText(from, textoAgregado(item, cantidad));

    const resumen = session.items
      .map(i => `• ${i.cantidad} ${nombrePorCantidad(i, i.cantidad)}`)
      .join("\n");

    await sendText(from, "🛒 *Tu pedido hasta ahora:*\n" + resumen);

    await sendButtons(from, {
      body: "¿Qué querés hacer ahora?",
      buttons: [
        { id: "AGREGAR_MAS", title: "➕ Agregar productos" },
        { id: "FIN_PRODUCTOS", title: "✅ Finalizar" },
        { id: "VACIAR_CARRITO", title: "🗑️ Vaciar" },
      ],
    });

    return;
  }

  if (id === "VACIAR_CARRITO") {
    session.items = [];
    await sendText(from, "🗑️ Carrito vaciado.");
    session.step = "productos";
    await setSession(from, session);
    await showProductos(from);
    return;
  }

  if (id === "FIN_PRODUCTOS") {
    if (!session.items.length) {
      await sendText(from, "❌ Tenés que elegir al menos un producto.");
      return;
    }

    const requiereTurno = session.items.some(i => i.requiereTurno);

    // 🥩 SI NO REQUIERE TURNO → RETIRO DIRECTO
    if (!requiereTurno) {
      session.tipoPedido = "RETIRO_DIA";
      session.tipoRetiro = "retiro";
      session.step = "fecha";
      await setSession(from, session);
      await showFechasDisponibles(from, { modo: "retiro" });
      return;

    }

    // 🔪 SI REQUIERE TURNO → PREGUNTAR MODALIDAD
    session.step = "tipo_retiro";
    await showTipoRetiro(from);
    return;
  }

  // ======================
  // Tipo retiro
  // ======================
  if (id === "TIPO_DESPOSTE" || id === "TIPO_RETIRO") {
    const esDesposte = id === "TIPO_DESPOSTE";

    session.tipoPedido = esDesposte ? "TURNO" : "RETIRO_DIA";
    session.tipoRetiro = esDesposte ? "desposte" : "retiro";
    session.step = "fecha";

    await setSession(from, session);
    await showFechasDisponibles(from, { modo: session.tipoRetiro });
    return;
  }

  // ======================
  // Fecha
  // ======================
  if (id.startsWith("FECHA_")) {
    const fecha = id.replace("FECHA_", "");
    session.fecha = fecha;

    if (session.tipoPedido === "RETIRO_DIA") {
      session.hora = null;
      await setSession(from, session);
      await preguntarQuienRetira(from);
    } else {
      await showHorasDisponibles(from, fecha);
    }
    return;
  }

  // ======================
  // Hora
  // ======================
  if (id.startsWith("HORA_")) {
    session.hora = id.replace("HORA_", "");
    session.step = "pedir_quien_retira";
    await setSession(from, session);
    await preguntarQuienRetira(from);
    return;
  }

  // ======================
  // Confirmar
  // ======================
  if (id === "CONFIRMAR_PEDIDO") {
    await finalizarPedido(from);
    session = { step: "finalizado", lastAction: Date.now() };
    await setSession(from, session);
    return;
  }

  if (id === "CANCELAR_PEDIDO") {
    session.step = "menu";
    session.lastAction = Date.now();
    await setSession(from, session);
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
    body: "🔪 ¿Cómo querés recibir tu pedido?",
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
        description: "Retiro en el día (08:00 a 12:00 hs)",
      },
    ],
  });
}

function textoCantidad(producto) {
  const articulo =
    producto.genero === "femenino" ? "Cuántas" : "Cuántos";

  const nombre =
    producto.nombrePlural || producto.nombre;

  return `🔢 ¿${articulo} *${nombre}* querés?`;
}

function nombrePorCantidad(item, cantidad) {
  if (cantidad === 1) return item.nombre;
  return item.nombrePlural || item.nombre;
}

function textoAgregado(item, cantidad) {
  const nombre = nombrePorCantidad(item, cantidad);
  const verbo = item.genero === "femenino" ? "agregada" : "agregado";
  return `➕ *${cantidad} ${nombre}* ${verbo}`;
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
      ? "📅 Elegí el día (retiro de 08:00 a 12:00)"
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
  const s = await getSession(to);
  const tipoPedido = s?.tipoPedido;
  const fecha = s?.fecha;
  const hora = s?.hora;

  const tipoTexto =
    tipoPedido === "TURNO"
      ? "👀 Presenciar desposte"
      : "📦 Retiro (08:00 a 12:00)";

  const esTurno = tipoPedido === "TURNO";

  await sendButtons(to, {
    body:
      `✅ *Confirmá tu pedido*\n\n` +
      `👤 Cliente: *${s.cliente.nombre}*\n` +
      `📦 Retira: *${s.retira}*\n\n` +
      `🔪 Modalidad: *${tipoTexto}*\n` +
      `📅 Día: *${labelFecha(fecha)}*\n` +
      (esTurno
        ? `🕒 Turno: *${hora}*\n\n`
        : `🕒 Retiro: *08:00 a 12:00*\n\n`),
    buttons: [
      { id: "CONFIRMAR_PEDIDO", title: "✅ Confirmar" },
      { id: "CANCELAR_PEDIDO", title: "❌ Cancelar" },
      { id: "VACIAR_CARRITO", title: "🗑️ Vaciar" },
    ],
  });
}

// ======================
// Finalizar pedido (reserva turno + descuenta stock + guarda pedido)
// ======================
async function finalizarPedido(to) {
  const session = await getSession(to);
  const { fecha, hora, items, tipoPedido } = session;

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
      nombreCliente: session.cliente.nombre,
      retira: { nombre: session.retira },

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
    `👤 Cliente: *${session.cliente.nombre}*\n` +
    `📦 Retira: *${session.retira}*\n\n` +
    `🧾 Productos:\n` +
    items
      .map(i => `• ${i.cantidad} ${nombrePorCantidad(i, i.cantidad)}`)
      .join("\n") +
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

async function preguntarQuienRetira(to) {
  const session = await getSession(to);
  const cliente = session?.cliente;

  if (cliente?.ultimoRetira) {
    session.step = "quien_retira_opcion";
    await setSession(to, session);

    await sendButtons(to, {
      body: `👤 ¿Quién va a retirar?\n\nÚltimo: *${cliente.ultimoRetira}*`,
      buttons: [
        { id: "RETIRA_ULTIMO", title: `✅ ${safeTitle(cliente.ultimoRetira)}` },
        { id: "RETIRA_OTRO", title: "✍️ Otra persona" },
      ],
    });
    return;
  }

  session.step = "pedir_quien_retira";
  await setSession(to, session);
  await sendText(to, "👤 ¿Quién va a retirar el pedido?");
}

function safeTitle(text, max = 24) {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

async function showProductos(to) {
  const productos = await Producto.find({ activo: true });

  const rows = productos.map((p) => {
    const sinStock = (p.stock ?? 0) <= 0;

    return {
      id: sinStock ? `SINSTOCK_${p._id}` : `PROD_${p._id}`,
      title: safeTitle(sinStock ? `⛔ ${p.nombre}` : p.nombre),
      description: sinStock
        ? "Sin stock"
        : (p.requiereTurno ? "Requiere turno" : "Retiro en el día (08-12 hs)"),
    };
  });

  await sendList(to, {
    body:
      "🥩 *Elegí tus productos*\n\n" +
      "👉 Seleccioná *uno por vez*.\n" +
      "👉 Cada vez que elijas uno, podés *sumar otro* o *finalizar el pedido*.",
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
      hora: pedido.hora || "08:00-12:00",
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
      .map(i => {
        const nombre =
          i.kilosReales === 1
            ? i.nombre
            : (i.nombrePlural || i.nombre);

        return `• ${nombre}: ${i.kilosReales} kg → $${i.subtotal}`;
      })
      .join("\n") +
    `\n\n💰 Total: *$${pedido.precioFinal}*\n\n¡Gracias por tu compra! 🥩`
  );

  res.json({ ok: true, total });
});

