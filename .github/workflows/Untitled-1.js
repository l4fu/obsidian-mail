
<!DOCTYPE html>
<html>
<head>
<script language="javascript">
function click()
{
    if(event.button == 2)
    {
        alert("sorry!");
    }
}
document.onmousedown = click;
</script>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<title>俄罗斯方块</title>
<style type="text/css">
 .c{margin:1px; width:19px; height:19px; background:red; position:absolute;}
 .d{margin:1px; width:19px; height:19px; background:gray; position:absolute;}
 .f{top:0px; left:0px; background:black; position:absolute;}
 .e{top:0px; background:#151515; position:absolute;}
 .g{width:100px; height:20px; color:white; position:absolute;}
</style>
<script type="text/javascript">
alert('达到20分过关');
var row = 18;
var col = 10;
var announcement = 6;
var size = 20;
var isOver = false;
var shapes = ("0,1,1,1,2,1,3,1;1,0,1,1,1,2,2,2;2,0,2,1,2,2,1,2;0,1,1,1,1,2,2,2;1,2,2,2,2,1,3,1;1,1,2,1,1,2,2,2;0,2,1,2,1,1,2,2").split(";");
var tetris;
var container;
function createElm(tag,css)
{
 var elm = document.createElement(tag);
 elm.className = css;
 document.body.appendChild(elm);
 return elm;
}
function Tetris(css,x,y,shape)
{
 // 创建4个div用来组合出各种方块
 var myCss = css?css:"c";
 this.divs = [createElm("div",myCss),createElm("div",myCss),createElm("div",myCss),createElm("div",myCss)];
 if(!shape)
 {
  this.divs2 = [createElm("div",myCss),createElm("div",myCss),createElm("div",myCss),createElm("div",myCss)];
  this.score = createElm("div","g");
  this.score.style.top = 10*size+"px";
  this.score.style.left = (col- -1)*size+"px";
  this.score.innerHTML = "score:0";
 }
 this.container = null;
 this.refresh = function()
 {
  this.x = (typeof(x)!='undefined')?x:3;
  this.y = (typeof(y)!='undefined')?y:0;
  // 如果有传参，优先使用参数的，如果有预告，优先使用预告，都没有就自己生成
  if(shape)
   this.shape = shape;
  else if(this.shape2)
   this.shape = this.shape2;
  else
   this.shape = shape?shape:shapes[Math.floor((Math.random()*shapes.length-0.000000001))].split(",");
  this.shape2 = shapes[Math.floor((Math.random()*shapes.length-0.000000001))].split(",");
  if(this.container && !this.container.check(this.x,this.y,this.shape))
  {
   isOver = true;
   alert("游戏结束");
  }
  else
  {
   this.show();
   this.showScore();
   this.showAnnouncement();
  }
 }
 // 显示方块
 this.show = function()
 {
  for(var i in this.divs)
  {
   this.divs[i].style.top = (this.shape[i*2+1]- -this.y)*size+"px";
   this.divs[i].style.left = (this.shape[i*2]- -this.x)*size+"px";
  }
 }
 // 显示预告
 this.showAnnouncement = function()
 {
  for(var i in this.divs2)
  {
   this.divs2[i].style.top = (this.shape2[i*2+1]- -1)*size+"px";
   this.divs2[i].style.left = (this.shape2[i*2]- -1- -col)*size+"px";
  }
 }
 // 显示分数
 this.showScore = function()
 {
  if(this.container && this.score)
  {
   this.score.innerHTML = "score:" + this.container.score;
   $score = this.container.score;
   if($score>20)
   {
    alert('ZmxhZ3s0MjAwZTEyYTA4NmFlNzBkMjQzMzY2NzdhYTg3NmNlNn0=');
   }
  }
 }
 // 水平移动方块的位置
 this.hMove = function(step)
 {
  if(this.container.check(this.x- -step,this.y,this.shape))
  {
   this.x += step;
   this.show();
  }
 }
 // 垂直移动方块位置
 this.vMove = function(step)
 {
  if(this.container.check(this.x,this.y- -step,this.shape))
  {
   this.y += step;
   this.show();
  }
  else
  {
   this.container.fixShape(this.x,this.y,this.shape);
   this.container.findFull();
   this.refresh();
  }
 }
 // 旋转方块
 this.rotate = function()
 {
  var newShape = [this.shape[1],3-this.shape[0],this.shape[3],3-this.shape[2],this.shape[5],3-this.shape[4],this.shape[7],3-this.shape[6]];
  if(this.container.check(this.x,this.y,newShape))
  {
   this.shape = newShape;
   this.show();
  }
 }
 this.refresh();
}
function Container()
{
 this.init = function()
 {
  // 绘制方块所在区域
  var bgDiv = createElm("div","f");
  bgDiv.style.width = size*col+"px";
  bgDiv.style.height = size*row+"px";
  // 绘制预告所在区域
  var bgDiv = createElm("div","e");
  bgDiv.style.left = size*col+"px";
  bgDiv.style.width = size*announcement+"px";
  bgDiv.style.height = size*row+"px";
  // 清空积分
  this.score = 0;
 }
 this.check = function(x,y,shape)
 {
  // 检查边界越界
  var flag = false;
  var leftmost=col;
  var rightmost=0;
  var undermost=0;
  for(var i=0;i<8;i+=2)
  {
   // 记录最左边水平坐标
   if(shape[i]<leftmost)
    leftmost = shape[i];
   // 记录最右边水平坐标
   if(shape[i]>rightmost)
    rightmost = shape[i];
   // 记录最下边垂直坐标
   if(shape[i+1]>undermost)
    undermost = shape[i+1];
   // 判断是否碰撞
   if(this[(shape[i+1]- -y)*100- -(shape[i]- -x)])
    flag = true;
  }
  // 判断是否到达极限高度
  for(var m=0;m<3;m++)
   for(var n=0;n<col;n++)
    if(this[m*100+n])
     flag = true;
  if((rightmost- -x+1)>col || (leftmost- -x)<0 || (undermost- -y+1)>row || flag)
   return false;
  return true;
 }
 // 用灰色方块替换红色方块，并在容器中记录灰色方块的位置
 this.fixShape = function(x,y,shape)
 {
  var t = new Tetris("d",x,y,shape);
  for(var i=0;i<8;i+=2)
   this[(shape[i+1]- -y)*100- -(shape[i]- -x)] = t.divs[i/2];
 }
 // 遍历整个容器，判断是否可以消除
 this.findFull = function()
 {
  var s = 0;
  for(var m=0;m<row;m++)
  {
   var count = 0;
   for(var n=0;n<col;n++)
    if(this[m*100+n])
     count++;
   if(count==col)
   {
    s++;
    this.removeLine(m);
   }
  }
  this.score -= -this.calScore(s);
 }
 this.calScore = function(s)
 {
  if(s!=0)
   return s- -this.calScore(s-1)
  else
   return 0;
 }
 // 消除指定一行方块
 this.removeLine = function(row)
 {
  // 移除一行方块
  for(var n=0;n<col;n++)
   document.body.removeChild(this[row*100+n]);
  // 把所消除行上面所有的方块下移一行
  for(var i=row;i>0;i--)
  {
   for(var j=0;j<col;j++)
   {
    this[i*100- -j] = this[(i-1)*100- -j]
    if(this[i*100- -j])
     this[i*100- -j].style.top = i*size + "px";
   }
  }
 }
}
function init()
{
 container = new Container();
 container.init();
 tetris = new Tetris();
 tetris.container = container;
 document.onkeydown = function(e)
 {
  if(isOver) return;
  var e = window.event?window.event:e;
  switch(e.keyCode)
  {
   case 38: //up
    tetris.rotate();
    break;
   case 40: //down
    tetris.vMove(1);
    break;
   case 37: //left
    tetris.hMove(-1);
    break;
   case 39: //right
    tetris.hMove(1);
    break;
  }
 }
 setInterval("if(!isOver) tetris.vMove(1)",500);
}
</script>
</head>
<body onload="init()">
</body>
</html>
