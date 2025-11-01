const {
    Client,
    Events,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionsBitField
} = require("discord.js");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const fetch = require("node-fetch");
const fs = require("fs");
const config = require("./config.js");

// ===== Nastavení =====
const REVERIFY_MINUTES = 5;
const DELAY_MS = (config.delay_minutes || 0) * 60 * 1000;
const ERROR_IMAGE = config.error_image_url || "https://files.catbox.moe/bn09gs.png";
const MAIN_ROLE_ID = config.role_id || null;
const EXTRA_ROLE_ID = config.extra_role_id || null;
const SAVE_DATA = config.save_data === "true";
const CLEAN_CHANNEL_ID = config.clean_channel_id || null;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// ===== Pomocné funkce =====
function loadSubscribers() {
    if (!fs.existsSync("subscriber.json")) return [];
    try {
        return JSON.parse(fs.readFileSync("subscriber.json", "utf8"));
    } catch {
        return [];
    }
}

function saveSubscriber(userId, username) {
    const subs = loadSubscribers();
    const now = new Date().toISOString();
    const i = subs.findIndex(s => s.id === userId);
    if (i !== -1) {
        subs[i].time = now;
        subs[i].username = username;
    } else {
        subs.push({ id: userId, username, time: now });
    }
    fs.writeFileSync("subscriber.json", JSON.stringify(subs, null, 2));
}

function removeSubscriber(userId) {
    const subs = loadSubscribers();
    const filtered = subs.filter(s => s.id !== userId);
    fs.writeFileSync("subscriber.json", JSON.stringify(filtered, null, 2));
}

function isUserOnCooldown(userId) {
    const subs = loadSubscribers();
    const rec = subs.find(s => s.id === userId);
    if (!rec) return false;
    const last = new Date(rec.time);
    const minutes = (Date.now() - last.getTime()) / 1000 / 60;
    return minutes < REVERIFY_MINUTES;
}

// ===== Start bota =====
client.once(Events.ClientReady, async (readyClient) => {
    console.log(`✅ Logged in as ${readyClient.user.tag}`);

    // Registrace příkazů
    const commands = [
        new SlashCommandBuilder()
            .setName("verify")
            .setDescription("Verify your YouTube subscription with a screenshot")
            .addAttachmentOption(opt =>
                opt
                    .setName("image")
                    .setDescription("Screenshot showing you are subscribed")
                    .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName("unverify")
            .setDescription("Remove your verification roles and record")
    ].map(c => c.toJSON());

    const rest = new REST({ version: "10" }).setToken(config.token);
    try {
        await rest.put(
            Routes.applicationGuildCommands(readyClient.user.id, config.guild_id),
            { body: commands }
        );
        console.log("✅ Registered /verify and /unverify.");
    } catch (err) {
        console.error("❌ Command registration failed:", err);
    }
});

// ===== Mazání nových zpráv v roomce =====
const botStartTime = Date.now();

client.on(Events.MessageCreate, async (message) => {
    if (!CLEAN_CHANNEL_ID) return;
    if (message.channelId !== CLEAN_CHANNEL_ID) return;
    if (message.author.bot) return;
    if (message.createdTimestamp < botStartTime) return; // ⚙️ nechat staré zprávy být

    try {
        await message.delete();
        console.log(`🧹 Deleted message from ${message.author.tag} in verify room`);
    } catch (err) {
        console.error("❌ Could not delete message:", err);
    }
});

// ===== Slash příkazy =====
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // ✅ Povoleno jen v clean_channel_id
    if (interaction.channelId === CLEAN_CHANNEL_ID) {
        const allowed = ["verify", "unverify"];
        if (!allowed.includes(interaction.commandName)) {
            await interaction.reply({
                content: "❌ Tento příkaz zde není povolen.",
                ephemeral: true
            });
            return;
        }
    }

    const name = interaction.commandName;

    // ---------- /unverify ----------
    if (name === "unverify") {
        await interaction.deferReply({ ephemeral: true });
        const member = interaction.member;
        if (!member) {
            await interaction.followUp({ content: "❌ Member not found.", ephemeral: true });
            return;
        }

        if (MAIN_ROLE_ID && member.roles.cache.has(MAIN_ROLE_ID)) {
            try { await member.roles.remove(MAIN_ROLE_ID); } catch (err) {}
        }
        if (EXTRA_ROLE_ID && member.roles.cache.has(EXTRA_ROLE_ID)) {
            try { await member.roles.remove(EXTRA_ROLE_ID); } catch (err) {}
        }

        removeSubscriber(member.user.id);
        await interaction.followUp({
            content: "✅ Your verification was removed. You can /verify again.",
            ephemeral: true
        });
        return;
    }

    // ---------- /verify ----------
    if (name === "verify") {
        const member = interaction.member;
        await interaction.deferReply({ ephemeral: true });

        if (!member) {
            await interaction.followUp({ content: "❌ Member not found.", ephemeral: true });
            return;
        }

        if (isUserOnCooldown(member.user.id)) {
            await interaction.followUp({
                content: `⏳ You can verify again after ${REVERIFY_MINUTES} minutes.`,
                ephemeral: true
            });
            return;
        }

        const image = interaction.options.getAttachment("image");
        if (!image || !image.url) {
            await interaction.followUp({ content: "❌ Please provide an image.", ephemeral: true });
            return;
        }

        const allowed = ["jpeg", "jpg", "png", "webp", "gif"];
        const url = new URL(image.url);
        const ext = url.pathname.split(".").pop().toLowerCase();
        if (!allowed.includes(ext)) {
            await interaction.followUp({
                content: "❌ Unsupported file format. Upload JPEG / PNG / WEBP / GIF.",
                ephemeral: true
            });
            return;
        }

        try {
            const res = await fetch(image.url);
            const buf = Buffer.from(await res.arrayBuffer());
            const processed = await sharp(buf).resize({ width: 1000 }).toBuffer();

            const ocr = await Tesseract.recognize(processed);
            const text = ocr.data.text || "";
            const lower = text.toLowerCase();
            const channelLower = config.channel_name.toLowerCase();

            console.log("📄 OCR OUTPUT:\n" + text);

            let ok = lower.includes(channelLower);

            if (config.keywords) {
                const kws = config.keywords
                    .split(",")
                    .map(x => x.trim().toLowerCase())
                    .filter(Boolean);
                if (kws.some(kw => lower.includes(kw))) {
                    ok = true;
                }
            }

            if (!ok) {
                await interaction.followUp({
                    content: `❌ You haven't subscribed to ${config.channel_name}.\nIf this is an error, please send a better / cropped screenshot:`,
                    files: [ERROR_IMAGE],
                    ephemeral: true
                });
                return;
            }

            if (SAVE_DATA) saveSubscriber(member.user.id, member.user.username);

            if (DELAY_MS > 0) {
                await interaction.followUp({
                    content: `✅ Thanks for subscribing to ${config.channel_name}!\n🕒 Role(s) will be added in ${config.delay_minutes} minutes.`,
                    ephemeral: true
                });
            } else {
                await interaction.followUp({
                    content: `✅ Thanks for subscribing to ${config.channel_name}!`,
                    ephemeral: true
                });
            }

            const addRoles = async () => {
                const guild = interaction.guild;
                const me = await guild.members.fetch(client.user.id);
                const fresh = await guild.members.fetch(member.user.id);

                // hlavní role
                if (MAIN_ROLE_ID) {
                    const r = guild.roles.cache.get(MAIN_ROLE_ID);
                    if (r && me.permissions.has(PermissionsBitField.Flags.ManageRoles) && me.roles.highest.position > r.position) {
                        await fresh.roles.add(MAIN_ROLE_ID).catch(() => {});
                    }
                }

                // extra role
                if (EXTRA_ROLE_ID) {
                    const r2 = guild.roles.cache.get(EXTRA_ROLE_ID);
                    if (r2 && me.permissions.has(PermissionsBitField.Flags.ManageRoles) && me.roles.highest.position > r2.position) {
                        await fresh.roles.add(EXTRA_ROLE_ID).catch(() => {});
                    }
                }
            };

            if (DELAY_MS > 0) setTimeout(addRoles, DELAY_MS);
            else await addRoles();

        } catch (err) {
            console.error("❌ Error processing image:", err);
            await interaction.followUp({
                content: "❌ There was an error processing the image. Please try again.",
                ephemeral: true
            });
        }
    }
});

client.login(config.token).catch(err => console.error("❌ Failed to login:", err));
