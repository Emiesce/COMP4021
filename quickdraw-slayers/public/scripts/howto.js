// How to Play: a pop-up slideshow (one .howto-step at a time) over the game's battle background.
//
// Pages are grouped (data-group on each .howto-step):
//   basics   the walkthrough every new player must finish
//   cards    attack / block / utility cards and combos (grids are built from Game.CARD_POOL)
//   enemies  the three bosses (built from Game.ENEMIES)
//
// Two modes:
//   optional (the yellow ? button): all groups, tabs, X button, Escape and clicking the dark background close it.
//   required (new players): only the basics, no tabs and no way to skip. Back/Next only, Done on the last page.
//
// Each basics page with data-shot="NAME" looks for an image in public/images/howto/ called
// NAME.gif, NAME.png or NAME.jpg. Drop your screenshots/GIFs there and they appear automatically;
// until then a placeholder box is shown.
const HowTo = (function() {
    const EXTENSIONS = ["gif", "png", "jpg"];
    const TYPE_LABEL = { ATTACK: "Attack", BLOCK: "Block", UTILITY: "Utility" };
    const ENEMY_BLURB = {
        enemy_typhoon: "Steady, lighter hits. The easiest one to out-block.",
        enemy_firebird: "Hits hardest of the three. Shield up before the timer ends.",
        enemy_dragon: "Alternates a weaker and a full-strength blast."
    };
    const CARD_TIP = {
        pop_quiz: "Cheap and quick. Great when your Energy is low.",
        dragonboat: "A solid hit for a fair price.",
        final_exam: "Your biggest hit. Save up 3 Energy for it.",
        lab_explosion: "Nearly as strong as Final Exam.",
        shield: "Play it just before the enemy attacks.",
        office_hours: "A little less Shield for the same price.",
        group_project: "Also starts a combo. Great before a big attack.",
        bell_curve: "Also starts a combo. Follow it with your best card.",
        milk_tea: "Use it when your HP is getting low.",
        extension: "Great when you or your partner hold costly cards."
    };
    let afterClose = null;          // function to run when the guide is closed (or null)
    let isRequired = false;
    let current = 0;
    let steps = [];                 // the pages shown in the current mode, in order

    const loadShot = function($step) {
        const name = $step.data("shot");
        if (!name) return;
        const $box = $("<div class='shot placeholder'>").text(`Screenshot/GIF goes here: images/howto/${name}.gif`);
        $step.append($box);
        const tryNext = (i) => {
            if (i >= EXTENSIONS.length) return;
            const img = new Image();
            img.onload = () => $box.empty().removeClass("placeholder").append(img);
            img.onerror = () => tryNext(i + 1);
            img.src = `images/howto/${name}.${EXTENSIONS[i]}`;
        };
        tryNext(0);
    };

    // Card pages: one tile per card of that type, taken from the game's own card list
    const buildCards = function() {
        if (typeof Game === "undefined" || !Game.CARD_POOL) return;
        $(".howto-step[data-cards]").each(function() {
            const type = $(this).data("cards");
            const $grid = $(this).find(".help-cards").empty();
            Game.CARD_POOL.filter(c => c.type === type).forEach(card => {
                $("<div class='help-card'>").css("--card-color", card.color).append(
                    $("<img alt=''>").attr("src", card.image),
                    $("<div class='help-card-body'>").append(
                        $("<strong class='help-card-name'>").text(card.name),
                        $("<div class='help-card-meta'>").append(
                            $("<span class='help-card-type'>").text(TYPE_LABEL[card.type] || card.type),
                            $("<span class='help-cost'>").text(card.cost + " Energy")),
                        $("<p>").text(card.description),
                        $("<p class='help-card-tip'>").text(CARD_TIP[card.id] || ""))
                ).appendTo($grid);
            });
        });
    };

    const buildEnemies = function() {
        if (typeof Game === "undefined" || !Game.ENEMIES) return;
        const $grid = $(".help-enemies").empty();
        Game.ENEMIES.forEach(e => {
            $("<div class='help-enemy'>").css("--card-color", e.color).append(
                $("<img alt=''>").attr("src", e.image.replace("_sheet", "")),
                $("<strong>").text(e.name),
                $("<div class='help-card-type'>").text("Attack: " + e.intent),
                $("<p>").text(ENEMY_BLURB[e.id] || ""),
                $("<div class='help-cost'>").text("Base damage " + e.baseDamage)
            ).appendTo($grid);
        });
        (Game.FLOOR_HEALTH || []).forEach((hp, i) => $("#help-hp-" + (i + 1)).text(hp));
    };

    const groupOf = (i) => $(steps[i]).data("group");

    // Show page i (0-based) of the current mode and update tabs, dots, counter and buttons
    const showStep = function(i) {
        current = Math.max(0, Math.min(steps.length - 1, i));
        const group = groupOf(current);
        $(".howto-step").hide();
        $(steps[current]).show();
        $("#howto-current").text(current + 1);
        $("#howto-total").text(steps.length);
        $(".howto-tab").each(function() { $(this).toggleClass("active", $(this).data("group") === group); });
        $("#howto-dots .dot").each(function() {
            const index = $(this).data("index");
            $(this).toggle(groupOf(index) === group).toggleClass("active", index === current);
        });
        $("#howto-prev").prop("disabled", current === 0);
        $("#howto-next").text(current === steps.length - 1 ? "Done" : "Next");
        $(".howto-wrap").scrollTop(0);
    };

    // Collect the pages for this mode and rebuild the dots
    const setup = function(required) {
        steps = $(".howto-step").filter(function() { return !required || $(this).data("group") === "basics"; }).get();
        $("#howto-dots").empty();
        steps.forEach((step, index) => {
            $("<button type='button' class='dot'>").data("index", index).attr("aria-label", "Page " + (index + 1))
                .on("click", () => showStep(index)).appendTo("#howto-dots");
        });
    };

    // Open the guide. `callback` runs after it is closed. required = true: it cannot be skipped.
    const open = function(callback, required) {
        afterClose = callback || null;
        isRequired = !!required;
        setup(isRequired);
        $("#howto-page").toggleClass("required", isRequired).css("display", "flex");
        $("#help-button").hide();
        showStep(0);
    };

    const close = function() {
        $("#howto-page").hide();
        $("#help-button").show();
        const callback = afterClose;
        afterClose = null;
        if (callback) callback();
    };

    // Hide the guide without running its "after close" action (used when the session ends)
    const dismiss = function() {
        afterClose = null;
        $("#howto-page").hide();
        $("#help-button").show();
    };

    const init = function() {
        $(".howto-step").each(function() { loadShot($(this)); });
        buildCards();
        buildEnemies();
        setup(false);
        showStep(0);

        $("#howto-prev").on("click", () => showStep(current - 1));
        $("#howto-next").on("click", () => { if (current === steps.length - 1) close(); else showStep(current + 1); });
        $(".howto-back").on("click", () => { if (!isRequired) close(); });
        $(".howto-tab").on("click", function() {
            if (isRequired) return;
            const first = steps.findIndex(s => $(s).data("group") === $(this).data("group"));
            if (first >= 0) showStep(first);
        });

        // Click on the dark background closes the optional guide
        $("#howto-page").on("click", function(e) {
            if (e.target === this && !isRequired) close();
        });

        // Keyboard: arrows move between pages, Escape closes the optional guide
        $(document).on("keydown", function(e) {
            if (!$("#howto-page").is(":visible")) return;
            if (e.key === "ArrowRight") $("#howto-next").click();
            else if (e.key === "ArrowLeft") showStep(current - 1);
            else if (e.key === "Escape" && !isRequired) close();
        });

        // The yellow ? opens the optional guide from any page
        $("#help-button").on("click", () => open(null, false));
    };

    return { init, open, dismiss };
})();
