const mongoose = require("mongoose");

const HorarioSchema = new mongoose.Schema(
    {
        dia: { type: Number, required: true, unique: true }, // 1=Lun ... 6=Sab
        nombre: { type: String, required: true },
        horas: [{ type: String, required: true }],
    },
    { collection: "horarios" }
);

module.exports =
    mongoose.models.Horario ||
    mongoose.model("Horario", HorarioSchema);
