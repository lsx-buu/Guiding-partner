import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanCompanionDraft, splitChatText } from '../src/channels/shared/chat-text.mjs';

test('cleans a high-confidence leaked companion drafting preamble', () => {
  const leaked = '用户提到《去你的岛》是前几天看的电影，还附上那张画。那我应该回应关于这部电影的感觉。记得《去你的岛》是带点伤感又暖的故事，和那张画的感觉很搭——女孩是阿花？男主是王领？对，画里的场景应该是电影里的细节。回应要贴合这种感觉，比如“原来这是《去你的岛》里的画面啊！这画真还原那股，明明没家但有彼此挡雨的感觉，难怪你当时看着会记住～”，自然一点，像聊天。原来这是《去你的岛》里的画面啊！这画还原得真好，明明没归处但有彼此撑伞挡雨，那股软戳的劲儿，你看完是不是还记着这一段～';
  assert.equal(
    cleanCompanionDraft(leaked),
    '原来这是《去你的岛》里的画面啊！这画还原得真好，明明没归处但有彼此撑伞挡雨，那股软戳的劲儿，你看完是不是还记着这一段～',
  );
});

test('cleans the newer existentialism drafting sample', () => {
  const leaked = '用户问“本质是什么？” 结合之前聊的存在主义，需要用贴合日常的话解释，别太学术。本质大概就是，如果你不是存在先于本质，本质就是别人给你定的标签、规定好的样子——比如“应该做个乖孩子”“应该当医生”那种预设。存在主义说反过来，你先活着，自己选的路，就是你的本质，没有别人给你画的框框。要口语化，别太绕。本质说白了就是“是什么”的固有定义——比如杯子“本质是装水的容器”，是提前定好的。但存在主义觉得人不一样，人没有预先定好的“本质”，得靠自己活着的经历、选的事，慢慢变成“自己这个样子”～';
  assert.equal(
    cleanCompanionDraft(leaked),
    '本质说白了就是“是什么”的固有定义——比如杯子“本质是装水的容器”，是提前定好的。但存在主义觉得人不一样，人没有预先定好的“本质”，得靠自己活着的经历、选的事，慢慢变成“自己这个样子”～',
  );
});

test('cleans conversational-emotion drafting variants without phrase enumeration', () => {
  const leaked = '用户在吐槽这种人“难搞，不道德”，需要共情，带点小愤慨又口语化。比如：“可不是嘛，占着位置又不想担责任，完全不考虑别人感受，太离谱了。” 或者更口语：“就是啊！占着坑还不干活，完全没考虑别人，离谱死了！” 这样自然点。对呀！占着位置又不担责任，完全没考虑别人感受，超离谱的！';
  assert.equal(cleanCompanionDraft(leaked), '对呀！占着位置又不担责任，完全没考虑别人感受，超离谱的！');

  const variant = '用户在吐槽那种人“难搞，不道德”，回应要接住情绪。比如：“可不是嘛，太离谱了。” 这样既接住了情绪，又简短，符合聊天感。对对对！占着坑还不干活，真的很气人。';
  assert.equal(cleanCompanionDraft(variant), '对对对！占着坑还不干活，真的很气人。');

  const historyVariant = '用户现在在和我一起吐槽那种不道德的人，需要共情，回应要贴合情绪，比如认同，带点小愤慨，自然简短。比如：“是啊，谁愿意被这么吊着啊，换谁都得气到。” 或者“可不是嘛，想想都堵得慌，这种人就该离远点。” 更口语一点，符合聊天感。没错没错，想想都堵得慌，这种人就该赶紧离远点，别影响心情！';
  assert.equal(cleanCompanionDraft(historyVariant), '没错没错，想想都堵得慌，这种人就该赶紧离远点，别影响心情！');

  const fullPlanningSentence = '用户在表达对这种人的不道德感的认同，我需要共情，自然接话，贴合之前的语气，不用太复杂，带点小附和的情绪。比如：“换谁都气啊。” 不对，更口语一点，符合短句，比如：“真的太气人啦！” 对，这样更自然，有情绪，又贴合聊天的感觉。可不！给人留了期待又随便放着，最后让别人难受，真的超气人的！';
  assert.equal(cleanCompanionDraft(fullPlanningSentence), '可不！给人留了期待又随便放着，最后让别人难受，真的超气人的！');

  const concisePlan = '用户在附和吐槽那种不负责的人，要共情，带点小情绪，自然点。比如：“想想都气！” 这样贴合情绪，口语化。就是说啊，把好好的事搅得乱糟糟，还得别人擦屁股，想想都气鼓鼓的！';
  assert.equal(cleanCompanionDraft(concisePlan), '就是说啊，把好好的事搅得乱糟糟，还得别人擦屁股，想想都气鼓鼓的！');

  const questionPlan = '用户问“这种人到底图什么呀”，要贴合之前的情绪，带点吐槽和不解，自然口语。比如：“谁知道呢，自私得很～” 这样符合之前的语气，可爱又带点小吐槽。谁知道呢，说不定就图个自己省心，完全不管别人遭不遭罪，自私得很呀～';
  assert.equal(cleanCompanionDraft(questionPlan), '谁知道呢，说不定就图个自己省心，完全不管别人遭不遭罪，自私得很呀～');
});

test('fails closed when a high-confidence drafting leak has no safe final', () => {
  assert.equal(
    cleanCompanionDraft('用户在吐槽这种人，需要共情，带点小愤慨又口语化。比如：“太离谱了。”'),
    '我刚刚有点跑题了，你再跟我说说？',
  );
  assert.equal(
    cleanCompanionDraft('用户问这个问题，需要用贴合日常的话解释，比如先举个生活里的例子，别太学术，要口语化。'),
    '我刚刚有点跑题了，你再跟我说说？',
  );
});

test('strips the final protocol marker and uses the last one', () => {
  assert.equal(cleanCompanionDraft('<<COMPANION_FINAL>>你好'), '你好');
  assert.equal(cleanCompanionDraft('泄露 <<COMPANION_FINAL>>旧稿 <<COMPANION_FINAL>>最终回复'), '最终回复');
  assert.equal(cleanCompanionDraft('泄露 <<COMPANION_FINAL>>'), '我刚刚有点跑题了，你再跟我说说？');
});

test('does not clean ordinary mentions or an isolated marker', () => {
  assert.equal(cleanCompanionDraft('用户提到的那部电影我也看过。'), '用户提到的那部电影我也看过。');
  assert.equal(cleanCompanionDraft('用户提到这部电影，我记得它很暖。'), '用户提到这部电影，我记得它很暖。');
  assert.equal(cleanCompanionDraft('用户问本质是什么？要口语化。'), '用户问本质是什么？要口语化。');
  assert.equal(cleanCompanionDraft('用户问本质是什么？比如你可以从日常经验说起。'), '用户问本质是什么？比如你可以从日常经验说起。');
  assert.equal(cleanCompanionDraft('这段话里普通提到“要口语化，别太绕”，但不是拟稿。'), '这段话里普通提到“要口语化，别太绕”，但不是拟稿。');
});

test('preserves ordinary, empty, and non-string values', () => {
  assert.equal(cleanCompanionDraft('  你好呀  '), '  你好呀  ');
  assert.equal(cleanCompanionDraft(''), '');
  assert.equal(cleanCompanionDraft(null), null);
});

test('companion chat text uses explicit line breaks and natural Chinese punctuation', () => {
  assert.deepEqual(splitChatText('先接住你。\n再问一句。', 36), ['先接住你。', '再问一句。']);
  assert.deepEqual(
    splitChatText('那就先搞钱咯，约会也得有经费嘛。你想找个来钱快的，还是慢慢做大的？', 24),
    ['那就先搞钱咯，约会也得有经费嘛。', '你想找个来钱快的，还是慢慢做大的？'],
  );
});
