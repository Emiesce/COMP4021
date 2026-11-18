// How to Play page. Each <section class="howto-step" data-shot="NAME"> looks for an image in
// public/images/howto/ called NAME.gif, NAME.png or NAME.jpg. Drop your screenshots/GIFs there
// (e.g. 02-play-card.gif) and they appear automatically; until then a placeholder box is shown.
const HowTo = (function() {
    const EXTENSIONS = ["gif", "png", "jpg"];
    let returnTo = "#game-room-start-page";     // the page to go back to

    const loadShot = function($step) {
        const name = $step.data("shot");
        const $box = $("<div class='shot'>").text(`Screenshot/GIF goes here: images/howto/${name}.gif`);
        $step.append($box);
        const tryNext = (i) => {
            if (i >= EXTENSIONS.length) return;
            const img = new Image();
            img.onload = () => $box.empty().removeClass("placeholder").append(img);
            img.onerror = () => tryNext(i + 1);
            img.src = `images/howto/${name}.${EXTENSIONS[i]}`;
        };
        $box.addClass("placeholder");
        tryNext(0);
    };

    const open = function(from) {
        returnTo = from;
        $(from).hide();
        $("#howto-page").show();
        $("#help-button").hide();
        window.scrollTo(0, 0);
    };

    const init = function() {
        $(".howto-step").each(function() { loadShot($(this)); });
        // The ? button opens How to Play from whichever page is showing, and Back returns there
        $("#help-button").on("click", function() {
            const pages = ["#game-room-start-page", "#game-room-signin-page", "#game-room-register-page", "#game-room-content-page"];
            const current = pages.find(p => $(p).is(":visible"));
            if (current) open(current);
        });
        $(".howto-back").on("click", function() {
            $("#howto-page").hide();
            $(returnTo).show();
            $("#help-button").show();
        });
    };

    return { init };
})();
